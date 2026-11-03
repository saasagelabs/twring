/**
 * Claude Code v2.1.282 stream-json stdout lines captured from real runs (trimmed to the fields the
 * mapper reads; ids and text kept verbatim).
 */
export const initLine = {
  type: 'system',
  subtype: 'init',
  tools: ['WebFetch', 'WebSearch'],
  mcp_servers: [],
  model: 'claude-sonnet-5',
  permissionMode: 'dontAsk',
};
export const statusLine = { type: 'system', subtype: 'status', status: 'requesting' };

const stream = (event: unknown) => ({ type: 'stream_event', event, parent_tool_use_id: null });

export const toolTurnLines: unknown[] = [
  initLine,
  statusLine,
  stream({ type: 'message_start', message: { id: 'msg_01A' } }),
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  stream({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'Let me check that' },
  }),
  stream({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: ' for you.' },
  }),
  {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Let me check that for you.' }] },
  },
  stream({ type: 'content_block_stop', index: 0 }),
  stream({
    type: 'content_block_start',
    index: 1,
    content_block: {
      type: 'tool_use',
      id: 'toolu_01MK3eiau1xCTNwTnRmuFaNe',
      name: 'WebSearch',
      input: {},
    },
  }),
  stream({
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"query":"Chennai weather"}' },
  }),
  stream({ type: 'content_block_stop', index: 1 }),
  stream({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
  stream({ type: 'message_stop' }),
  { type: 'rate_limit_event' },
  {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          tool_use_id: 'toolu_01MK3eiau1xCTNwTnRmuFaNe',
          type: 'tool_result',
          content: 'Web search results for query: "Chennai weather right now"',
        },
      ],
    },
  },
  stream({ type: 'message_start', message: { id: 'msg_01B' } }),
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
  stream({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'secret reasoning' },
  }),
  stream({ type: 'content_block_stop', index: 0 }),
  stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
  stream({
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'text_delta', text: 'Right now Chennai is having thunderstorms.' },
  }),
  stream({ type: 'content_block_stop', index: 1 }),
  stream({ type: 'message_stop' }),
  { type: 'system', subtype: 'post_turn_summary' },
  { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn' },
];

export const interruptedResult = {
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  stop_reason: null,
};
