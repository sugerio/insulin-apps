type OtpEmail = { from: string; to: string; subject: string; text: string };
type EmailBinding = { send(message: OtpEmail): Promise<unknown> };
type MailConfig = { enabled?: string; from?: string; binding?: EmailBinding };

export const isValidOtpEmailAddress = (value: string) => value.length <= 254 && /^[^\s@<>(),;:\\"\[\]]+@[^\s@<>(),;:\\"\[\]]+\.[^\s@<>(),;:\\"\[\]]+(?![\s\S])/.test(value);

/** Candidate adapter only: callers must establish a trusted sending boundary before wiring it to routes. */
export function createCloudflareOtpMailer(config: MailConfig): (to: string, otp: string) => Promise<void> {
  if (config.enabled !== 'true' || !config.from || !isValidOtpEmailAddress(config.from) || !config.binding || typeof config.binding.send !== 'function') throw new Error('Email sending is not configured');
  const from = config.from, binding = config.binding;
  return async (to, otp) => {
    if (!isValidOtpEmailAddress(to) || !/^\d{6}(?![\s\S])/.test(otp)) throw new Error('Invalid email delivery input');
    try {
      await binding.send({ from, to, subject: 'Your signing verification code', text: `Your signing verification code is ${otp}. It expires in 5 minutes.` });
    } catch {
      throw new Error('Email delivery failed');
    }
  };
}
