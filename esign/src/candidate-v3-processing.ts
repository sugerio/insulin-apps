import {processPositionedV3Job} from './positioned-v3-processing.ts';
import type {CandidateRecoveryGuard} from './candidate-recovery-authorization.ts';

/** Private management processing seam; it never signs or seals. */
export async function processCandidatePositionedV3Job(db:D1Database,bucket:R2Bucket,jobId:string,guard:CandidateRecoveryGuard & {taskId:string}):Promise<void> {
 await processPositionedV3Job(db,bucket,jobId,undefined,undefined,guard);
}
