import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialSessionState,
  enqueueDraft,
  markSteerPending,
  cancelQueueItem,
  reconcileSteerPromotion,
  deriveTurnNavItems,
  applySSEEvent,
  type TextPartEntity,
  type ReasoningPartEntity,
  type ToolPartEntity,
} from './sessionStore.ts';

describe('sessionStore', () => {
  it('initializes clean session state', () => {
    const s = createInitialSessionState('sess-1');
    assert.equal(s.sessionId, 'sess-1');
    assert.equal(s.status, 'idle');
    assert.equal(s.messages.length, 0);
    assert.equal(s.queue.length, 0);
  });

  it('manages steer queue states: queued -> steer_pending -> cancel', () => {
    let s = createInitialSessionState('sess-1');
    s = enqueueDraft(s, { id: 'q-1', text: '转向提问 1' });
    assert.equal(s.queue.length, 1);
    assert.equal(s.queue[0].state, 'queued');
    assert.equal(s.queue[0].text, '转向提问 1');

    s = markSteerPending(s, 'q-1');
    assert.equal(s.queue[0].state, 'steer_pending');

    const { nextState, cancelledItem } = cancelQueueItem(s, 'q-1');
    assert.equal(nextState.queue.length, 0);
    assert.equal(cancelledItem?.id, 'q-1');
    assert.equal(cancelledItem?.text, '转向提问 1');
  });

  it('promotes steer item to UserMessage and destroys queue card (形态 D)', () => {
    let s = createInitialSessionState('sess-1');
    s = enqueueDraft(s, { id: 'q-1', text: '请帮我写一个快速排序', images: [{ data: 'img-data' }] });
    s = markSteerPending(s, 'q-1');

    // 内核返回 steered 事件
    s = reconcileSteerPromotion(s, [{ text: '请帮我写一个快速排序' }]);

    // 待发卡片自动从队列中销毁出队
    assert.equal(s.queue.length, 0);

    // 会话中升级出现正式的 UserMessage 与 AssistantMessage
    assert.equal(s.messages.length, 2);
    const userMsg = s.messages[0];
    assert.equal(userMsg.role, 'user');
    assert.equal(userMsg.text, '请帮我写一个快速排序');
    assert.equal(userMsg.turn_ordinal, 0);
    assert.equal(userMsg.images?.[0]?.data, 'img-data'); // 继承多模态原图

    const asstMsg = s.messages[1];
    assert.equal(asstMsg.role, 'assistant');

    // 右侧大纲自动派生该转向提问
    const outline = deriveTurnNavItems(s.messages);
    assert.equal(outline.length, 1);
    assert.equal(outline[0].id, 'turn-nav-0');
    assert.equal(outline[0].ordinal, 0);
    assert.equal(outline[0].text, '请帮我写一个快速排序');
  });

  it('preserves natural causal order: parts stay in chronological sequence without reordering', () => {
    let s = createInitialSessionState('sess-1');
    // 用户提问
    s = applySSEEvent(s, { type: 'user', content: '第一问' });
    // 先产生思考块
    s = applySSEEvent(s, { type: 'reasoning', content: '思考步骤 1' });
    // 再产生正文
    s = applySSEEvent(s, { type: 'text', content: '这是回答正文' });

    const lastMsg = s.messages[s.messages.length - 1];
    assert.equal(lastMsg.role, 'assistant');
    assert.equal(lastMsg.parts.length, 2);

    assert.equal(lastMsg.parts[0].kind, 'reasoning');
    assert.equal((lastMsg.parts[0] as ReasoningPartEntity).text, '思考步骤 1');
    assert.equal(lastMsg.parts[1].kind, 'text');
    assert.equal((lastMsg.parts[1] as TextPartEntity).text, '这是回答正文');

    // 更多正文流式进入，直接聚合
    s = applySSEEvent(s, { type: 'text', content: '，以及后续结论' });
    const updatedMsg = s.messages[s.messages.length - 1];
    assert.equal(updatedMsg.parts.length, 2);
    assert.equal(updatedMsg.parts[1].kind, 'text');
    assert.equal((updatedMsg.parts[1] as TextPartEntity).text, '这是回答正文，以及后续结论');
  });

  it('handles tool calls in place without duplicate rows', () => {
    let s = createInitialSessionState('sess-1');
    s = applySSEEvent(s, { type: 'user', content: '查一下' });
    s = applySSEEvent(s, { type: 'tool_start', id: 'call-1', name: 'search', arguments: '{"q":"rust"}' });

    let asst = s.messages[s.messages.length - 1];
    assert.equal(asst.parts.length, 1);
    assert.equal(asst.parts[0].kind, 'tool');
    const toolPart = asst.parts[0] as ToolPartEntity;
    assert.equal(toolPart.status, 'pending');

    s = applySSEEvent(s, { type: 'tool_progress', id: 'call-1', progress: 'fetching data...' });
    asst = s.messages[s.messages.length - 1];
    assert.equal((asst.parts[0] as ToolPartEntity).status, 'running');
    assert.equal((asst.parts[0] as ToolPartEntity).progress, 'fetching data...');

    s = applySSEEvent(s, { type: 'tool_result', id: 'call-1', output: 'found 3 files', success: true, duration_ms: 120 });
    asst = s.messages[s.messages.length - 1];
    assert.equal((asst.parts[0] as ToolPartEntity).status, 'done');
    assert.equal((asst.parts[0] as ToolPartEntity).output, 'found 3 files');
    assert.equal((asst.parts[0] as ToolPartEntity).duration_ms, 120);
  });

  it('records permissions and questions as separate docs', () => {
    let s = createInitialSessionState('sess-1');
    s = applySSEEvent(s, {
      type: 'permission_request',
      approval_id: 'app-1',
      session_id: 'sess-1',
      call_id: 'call-9',
      tool_name: 'bash',
      arguments: '{"cmd":"rm -rf /tmp"}',
      reason: '清理临时文件',
    });

    assert.equal(s.permissions.length, 1);
    assert.equal(s.permissions[0].tool_name, 'bash');
    assert.equal(s.permissions[0].status, 'asked');

    s = applySSEEvent(s, {
      type: 'user_input_request',
      request_id: 101,
      session_id: 'sess-1',
      question: '请选择操作模式',
      options: ['A', 'B'],
      is_multi: false,
    });

    assert.ok(s.question);
    assert.equal(s.question?.question, '请选择操作模式');
    assert.equal(s.question?.options.length, 2);
  });
});
