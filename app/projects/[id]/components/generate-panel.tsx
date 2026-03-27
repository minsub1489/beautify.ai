'use client';

import { useMemo, useState } from 'react';

type ChatMessage = {
  id: string;
  role: 'system' | 'user';
  text: string;
};

const starterMessages: ChatMessage[] = [
  {
    id: 'system-1',
    role: 'system',
    text: 'AI가 PDF·녹음·노션·아래 메모를 함께 분석해 필기합니다. 시험 포인트, 코드 흐름, 개념 비교, 자주 틀리는 부분을 적어두면 더 좋아져요.',
  },
];

const quickPrompts = [
  '시험에 나온다고 강조한 부분 위주로 정리해줘',
  '코드 흐름과 함수 역할을 쉽게 설명해줘',
  '딥러닝 수식은 직관까지 같이 설명해줘',
  '암기해야 할 키워드를 굵게 느껴지게 정리해줘',
  '헷갈리기 쉬운 개념 비교표를 넣어줘',
];

export function GeneratePanel({ projectId, notionPlaceholder }: { projectId: string; notionPlaceholder?: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>(starterMessages);
  const [draft, setDraft] = useState('');

  const serializedNotes = useMemo(() => {
    return messages
      .filter((message) => message.role === 'user')
      .map((message, index) => `메모 ${index + 1}: ${message.text}`)
      .join('\n');
  }, [messages]);

  function addMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'user', text: trimmed }]);
    setDraft('');
  }

  function removeMessage(id: string) {
    setMessages((prev) => prev.filter((message) => message.id !== id));
  }

  return (
    <form className="card stack" style={{ gridColumn: 'span 7' }} action="/api/generate" method="post">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="customNotes" value={serializedNotes} />

      <div>
        <label className="label">노션 페이지 ID</label>
        <input className="input" name="notionPageId" placeholder={notionPlaceholder || '선택 사항'} />
      </div>

      <div>
        <div className="label">추가 메모 채팅</div>
        <div className="chatBox">
          {messages.map((message) => (
            <div key={message.id} className={`chatBubble ${message.role === 'system' ? 'bot' : 'user'}`}>
              <div>{message.text}</div>
              {message.role === 'user' ? (
                <button type="button" className="chip danger" onClick={() => removeMessage(message.id)}>
                  삭제
                </button>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      <div className="stack" style={{ gap: 10 }}>
        <textarea
          className="textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="예: 교수님이 역전파 유도를 시험에 낸다고 했고, CNN과 Transformer 차이를 표로 정리해줘"
        />
        <div className="row">
          <button type="button" className="button secondary" onClick={() => addMessage(draft)}>
            메모 추가
          </button>
          {quickPrompts.map((prompt) => (
            <button key={prompt} type="button" className="chip" onClick={() => addMessage(prompt)}>
              {prompt}
            </button>
          ))}
        </div>
        <div className="muted" style={{ fontSize: 13 }}>
          녹음이 없어도 여기 메모만으로 강조 포인트를 반영할 수 있어요. 코딩·AI·딥러닝 자료면 코드 흐름, 모델 구조, 수식 직관, 자주 틀리는 부분까지 더 강하게 반영합니다.
        </div>
      </div>

      <button className="button" type="submit">AI 필기 생성</button>
    </form>
  );
}
