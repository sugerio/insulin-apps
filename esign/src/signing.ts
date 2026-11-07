/** A pure transition only. Callers must establish identity, OTP and artifact validity from trusted storage. */
export type Task = {
  recipientId: string;
  status: 'ACTIVE' | 'SIGNED';
  inputArtifactId: string;
};

export type SigningAuthorization = {
  recipientId: string;
  inputArtifactId: string;
  otpVerified: boolean;
  consentAccepted: boolean;
};

export function sign(task: Task, authorization: SigningAuthorization): Task {
  if (task.status !== 'ACTIVE') throw new Error('Task is not active');
  if (task.recipientId !== authorization.recipientId) throw new Error('Recipient mismatch');
  if (task.inputArtifactId !== authorization.inputArtifactId) throw new Error('Artifact is stale');
  if (!authorization.otpVerified) throw new Error('OTP verification required');
  if (!authorization.consentAccepted) throw new Error('Consent required');
  return { ...task, status: 'SIGNED' };
}
