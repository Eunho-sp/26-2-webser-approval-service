import { AppError, missing, forbidden, invalidState } from './errors.js';

const alreadyApplied = () => new AppError(409, 'ALREADY_APPLIED', '이미 신청한 행사입니다.');
const capacityFull = () => new AppError(409, 'CAPACITY_FULL', '정원이 가득 차서 승인할 수 없습니다.');

// actor는 검증된 로그인 사용자입니다. repo의 저장 함수는 권한을 검사하지 않습니다.
// 모든 변경은 transaction() 안에서 "검사 → 상태 저장 → 이력 저장" 순서로 처리합니다.
export function createApplicationService(repo) {
  // 하나의 트랜잭션으로 work를 실행합니다.
  // BEGIN IMMEDIATE는 시작할 때 쓰기 잠금을 먼저 잡기 때문에,
  // 검사(읽기)와 변경(쓰기) 사이에 다른 요청이 끼어들지 못합니다.
  // work 안에서 오류가 나면(거부 오류든 저장 오류든) 전부 ROLLBACK합니다.
  function transaction(work) {
    repo.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      repo.db.exec('COMMIT');
      return result;
    } catch (error) {
      repo.db.exec('ROLLBACK');
      throw error;
    }
  }

  // 신청을 찾고, 그 신청이 속한 행사도 함께 돌려줍니다. 없으면 404.
  function findApplication(applicationId) {
    const application = repo.application(applicationId);
    if (!application) throw missing('신청');
    return { application, event: repo.event(application.eventId) };
  }

  // 이 행사의 담당 운영자인지 확인합니다. 아니면 403.
  function assertManager(actor, event) {
    if (actor.role !== 'MANAGER' || event.managerId !== actor.id) throw forbidden();
  }

  return {
    // TODO-01 신청: 행사 존재 → 학생 역할 → 중복 → PENDING 저장 + APPLY 이력
    apply(actor, eventId) {
      return transaction(() => {
        const event = repo.event(eventId);
        if (!event) throw missing('행사');
        if (actor.role !== 'STUDENT') throw forbidden();
        // 상태와 상관없이 기록이 있으면 중복입니다(CANCELLED·REVOKED 포함).
        if (repo.existing(event.id, actor.id)) throw alreadyApplied();

        const application = repo.insert(event.id, actor.id);
        repo.addHistory({
          applicationId: application.id, actorId: actor.id,
          action: 'APPLY', fromStatus: null, toStatus: 'PENDING'
        });
        return application;
      });
    },

    // TODO-02 대기 취소: 신청 존재 → 본인 → PENDING → CANCELLED + CANCEL 이력
    // 대기 취소는 승인 자리를 비우지 않으므로 자동 승급하지 않습니다.
    cancel(actor, applicationId) {
      return transaction(() => {
        const { application } = findApplication(applicationId);
        if (application.userId !== actor.id) throw forbidden();
        if (application.status !== 'PENDING') throw invalidState();

        const cancelled = repo.setStatus(application.id, 'CANCELLED');
        repo.addHistory({
          applicationId: application.id, actorId: actor.id,
          action: 'CANCEL', fromStatus: 'PENDING', toStatus: 'CANCELLED'
        });
        return cancelled;
      });
    },

    // TODO-03 직접 승인: 신청 존재 → 담당자 → PENDING → 정원 → APPROVED + APPROVE 이력
    approve(actor, applicationId) {
      return transaction(() => {
        const { application, event } = findApplication(applicationId);
        assertManager(actor, event);
        if (application.status !== 'PENDING') throw invalidState();
        // 정원에는 APPROVED만 셉니다.
        if (repo.approvedCount(event.id) >= event.capacity) throw capacityFull();

        const approved = repo.setStatus(application.id, 'APPROVED');
        repo.addHistory({
          applicationId: application.id, actorId: actor.id,
          action: 'APPROVE', fromStatus: 'PENDING', toStatus: 'APPROVED'
        });
        return approved;
      });
    },

    // TODO-04 승인 취소 + 자동 승급: 신청 2건과 이력 2건을 한 트랜잭션으로 처리
    revoke(actor, applicationId, reason) {
      return transaction(() => {
        const { application, event } = findApplication(applicationId);
        assertManager(actor, event);
        if (application.status !== 'APPROVED') throw invalidState();

        // 1) 대상 신청을 REVOKED로 바꾸고 REVOKE 이력을 남깁니다.
        const revoked = repo.setStatus(application.id, 'REVOKED');
        const revokeHistoryId = repo.addHistory({
          applicationId: application.id, actorId: actor.id,
          action: 'REVOKE', fromStatus: 'APPROVED', toStatus: 'REVOKED', reason
        });

        // 2) 같은 행사의 다음 대기자 1명을 고릅니다. 없으면 자리를 비워 둡니다.
        const next = repo.nextPending(event.id);
        if (!next) return { revoked, promoted: null };

        // 3) 대기자를 승인하고, 원인이 된 REVOKE 이력 ID를 함께 기록합니다.
        const promoted = repo.setStatus(next.id, 'APPROVED');
        repo.addHistory({
          applicationId: next.id, actorId: actor.id,
          action: 'AUTO_APPROVE', fromStatus: 'PENDING', toStatus: 'APPROVED',
          causeHistoryId: revokeHistoryId
        });
        return { revoked, promoted };
      });
    }
  };
}
