// shadcn/ui's class-name helper (MIT): clsx for conditions, tailwind-merge so a later class wins over a conflicting one.
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
