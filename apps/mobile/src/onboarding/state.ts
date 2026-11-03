/**
 * Whether first-run onboarding has been seen in this app process. There is no on-device storage
 * module in the current native build, so "completed" is also inferred from the server: once an
 * agent exists, Home never shows onboarding again. A fresh launch with no agents shows it again,
 * which leads straight back into Connect Agent.
 */
let seen = false;

export function onboardingSeen(): boolean {
  return seen;
}

export function markOnboardingSeen(): void {
  seen = true;
}

/** Onboarding shows only while there is no agent and it hasn't been seen this session. */
export function shouldShowOnboarding(agentCount: number, alreadySeen: boolean): boolean {
  return agentCount === 0 && !alreadySeen;
}
