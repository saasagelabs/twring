import { isActive, type CallState } from '@twring/contracts';

export function shouldShowCallBar(pathname: string, call: CallState): boolean {
  return (
    isActive(call) &&
    pathname !== '/call' &&
    !pathname.startsWith('/incoming/') &&
    pathname !== '/sign-in' &&
    pathname !== '/onboarding' &&
    pathname !== '/waitlist'
  );
}
