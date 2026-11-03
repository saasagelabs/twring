import type { InviteAnswer } from '@/api/client';

export function chatAnswerRoute(answer: InviteAnswer) {
  return answer.mode === 'chat'
    ? { pathname: '/chats/[agentId]' as const, params: { agentId: answer.agentId, listen: '1' } }
    : undefined;
}
