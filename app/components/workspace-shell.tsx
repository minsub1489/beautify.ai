'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight, Languages, Paperclip, Pencil, Plus, UploadCloud } from 'lucide-react';
import { AuthControls } from './auth-controls';

type ProjectItem = {
  id: string;
  title: string;
  subject?: string | null;
  assetCount: number;
  hasOutput: boolean;
};

type MessageItem = {
  id: string;
  role: string;
  text: string;
  createdAt: string;
};

type AssetItem = {
  id: string;
  kind: string;
  originalName: string;
  publicUrl: string;
};

type RunSummary = {
  summary?: string | null;
  outputUrl?: string | null;
  examFocusJson?: unknown;
  questionsJson?: unknown;
};

type SelectedProject = {
  id: string;
  title: string;
  subject?: string | null;
  description?: string | null;
  messages: MessageItem[];
  assets: AssetItem[];
  lastRun?: RunSummary | null;
  latestPdfExcerpt?: string;
};

type QuizItem = {
  question: string;
  answer: string;
  hint?: string;
};

function sanitizeText(value: unknown, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function parseQuizItems(raw: unknown): QuizItem[] {
  if (!Array.isArray(raw)) return [];

  const parsed = raw
    .map((item): QuizItem | null => {
      if (typeof item === 'string') {
        const question = item
          .replace(/^\s*(중간|기말|midterm|final)\s*[:|-]\s*/i, '')
          .trim();
        if (!question) return null;
        return {
          question,
          answer: '생성된 필기와 요약을 참고해 스스로 답해보세요.',
          hint: '핵심 용어 정의, 비교 포인트, 적용 예시를 함께 떠올려 보세요.',
        };
      }

      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      const question = sanitizeText(record.question);
      const answer = sanitizeText(record.answer, '정답 요약이 제공되지 않았습니다.');
      const hint = sanitizeText(record.hint);
      if (!question) return null;
      return { question, answer, hint: hint || undefined };
    })
    .filter((item): item is QuizItem => Boolean(item));
  return parsed;
}

export function WorkspaceShell({
  projects,
  selectedProject,
}: {
  projects: ProjectItem[];
  selectedProject: SelectedProject | null;
}) {
  const router = useRouter();
  const attachmentRef = useRef<HTMLInputElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [pdfName, setPdfName] = useState('');
  const [audioName, setAudioName] = useState('');
  const [dragging, setDragging] = useState(false);
  const [attachmentNames, setAttachmentNames] = useState<string[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationStatus, setGenerationStatus] = useState('');
  const [liveNotes, setLiveNotes] = useState<string[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(300);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [translationMode, setTranslationMode] = useState<'original' | 'translated'>('original');
  const [translationLines, setTranslationLines] = useState<{ original: string; translation: string }[]>([]);
  const [translationLoading, setTranslationLoading] = useState(false);
  const [translationStatus, setTranslationStatus] = useState('');
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [titleSaving, setTitleSaving] = useState(false);
  const [titleError, setTitleError] = useState('');
  const [titleErrorTick, setTitleErrorTick] = useState(0);
  const [creditBalance, setCreditBalance] = useState<string>('0');
  const [billingStatus, setBillingStatus] = useState('');
  const [loadingBalance, setLoadingBalance] = useState(false);
  const [autoRechargeEnabled, setAutoRechargeEnabled] = useState(false);
  const [workspaceView, setWorkspaceView] = useState<'notes' | 'quiz'>('notes');

  const quickPrompts = useMemo(
    () => [
      '시험에 나온다고 강조한 부분 위주로 정리해줘',
      '헷갈리는 개념 비교표를 넣어줘',
      '코드 흐름과 함수 역할을 쉽게 설명해줘',
      '수식은 직관과 예시까지 같이 설명해줘',
    ],
    [],
  );

  const progressLines = useMemo(
    () => [
      'PDF 본문과 첨부 자료를 읽는 중...',
      '강의 핵심 개념을 페이지별로 정리하는 중...',
      '시험 포인트와 중간/기말 대비 퀴즈를 구성하는 중...',
      '미리보기용 필기를 PDF 위에 반영하는 중...',
    ],
    [],
  );

  const quizItems = useMemo(() => parseQuizItems(selectedProject?.lastRun?.questionsJson), [selectedProject?.lastRun?.questionsJson]);

  const previewPdfUrl = useMemo(() => {
    if (!selectedProject) return '';

    const latestOutput = [...selectedProject.assets]
      .reverse()
      .find((asset) => asset.kind === 'output_pdf');
    if (latestOutput) return `/api/assets/${latestOutput.id}/raw`;

    const latestPdf = [...selectedProject.assets]
      .reverse()
      .find((asset) => asset.kind === 'pdf');
    if (latestPdf) return `/api/assets/${latestPdf.id}/raw`;

    return '';
  }, [selectedProject]);

  const SIDEBAR_MIN = 220;
  const SIDEBAR_MAX = 520;
  const SIDEBAR_COLLAPSE_THRESHOLD = 170;

  useEffect(() => {
    function preventBrowserFileOpen(event: DragEvent) {
      event.preventDefault();
    }

    window.addEventListener('dragover', preventBrowserFileOpen);
    window.addEventListener('drop', preventBrowserFileOpen);

    return () => {
      window.removeEventListener('dragover', preventBrowserFileOpen);
      window.removeEventListener('drop', preventBrowserFileOpen);
    };
  }, []);

  useEffect(() => {
    if (!sidebarResizing) return;

    function onMove(event: MouseEvent) {
      const sidebar = sidebarRef.current;
      if (!sidebar) return;
      const bounds = sidebar.getBoundingClientRect();
      const rawWidth = event.clientX - bounds.left;

      if (rawWidth < SIDEBAR_COLLAPSE_THRESHOLD) {
        setSidebarCollapsed(true);
        setSidebarResizing(false);
        return;
      }

      const nextWidth = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, rawWidth));
      setSidebarCollapsed(false);
      setSidebarWidth(nextWidth);
    }

    function onUp() {
      setSidebarResizing(false);
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [sidebarResizing]);

  useEffect(() => {
    setTranslationMode('original');
    setTranslationLines([]);
    setTranslationLoading(false);
    setTranslationStatus('');
  }, [selectedProject?.id]);

  useEffect(() => {
    setEditingTitle(false);
    setTitleSaving(false);
    setTitleError('');
    setTitleDraft(selectedProject?.title || '');
  }, [selectedProject?.id, selectedProject?.title]);

  useEffect(() => {
    setWorkspaceView('notes');
  }, [selectedProject?.id]);

  useEffect(() => {
    let active = true;
    async function loadBalance() {
      setLoadingBalance(true);
      try {
        const response = await fetch('/api/billing/balance');
        const payload = await response.json().catch(() => ({}));
        if (!active) return;
        if (!response.ok) {
          setBillingStatus(typeof payload?.error === 'string' ? payload.error : '잔액 정보를 불러오지 못했습니다.');
          return;
        }
        setCreditBalance(String(payload?.balance || '0'));
        setAutoRechargeEnabled(Boolean(payload?.autoRecharge?.enabled));
      } catch {
        if (!active) return;
        setBillingStatus('잔액 정보를 불러오는 중 네트워크 오류가 발생했습니다.');
      } finally {
        if (active) setLoadingBalance(false);
      }
    }

    void loadBalance();
    return () => {
      active = false;
    };
  }, []);

  async function refreshBalance() {
    try {
      const response = await fetch('/api/billing/balance');
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) return;
      setCreditBalance(String(payload?.balance || '0'));
      setAutoRechargeEnabled(Boolean(payload?.autoRecharge?.enabled));
    } catch {}
  }

  async function quickCharge() {
    const idempotencyKey = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    setBillingStatus('');
    try {
      const response = await fetch('/api/billing/charge/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          amountKrw: 10000,
          creditAmount: 10000,
          provider: 'mockpay',
          idempotencyKey,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setBillingStatus(typeof payload?.error === 'string' ? payload.error : '충전에 실패했습니다.');
        return;
      }

      const confirmResponse = await fetch('/api/billing/webhook/mockpay', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          eventId: `evt-${idempotencyKey}`,
          paymentOrderId: payload?.orderId,
          amountKrw: 10000,
          creditAmount: 10000,
        }),
      });
      const confirmPayload = await confirmResponse.json().catch(() => ({}));
      if (!confirmResponse.ok) {
        setBillingStatus(typeof confirmPayload?.error === 'string' ? confirmPayload.error : '결제 확정 처리에 실패했습니다.');
        return;
      }

      setBillingStatus('10,000 크레딧이 충전되었습니다. (웹훅 확정)');
      await refreshBalance();
    } catch {
      setBillingStatus('충전 요청 중 네트워크 오류가 발생했습니다.');
    }
  }

  async function toggleAutoRecharge(checked: boolean) {
    setBillingStatus('');
    try {
      const response = await fetch('/api/billing/auto-recharge/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          enabled: checked,
          threshold: 1000,
          rechargeAmountKrw: 10000,
          rechargeCreditAmount: 10000,
          paymentMethodRef: 'mock-default-card',
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setBillingStatus(typeof payload?.error === 'string' ? payload.error : '자동충전 설정 저장에 실패했습니다.');
        return;
      }
      setAutoRechargeEnabled(checked);
      setBillingStatus(checked ? '자동충전을 켰습니다. (임계치 1,000)' : '자동충전을 껐습니다.');
      await refreshBalance();
    } catch {
      setBillingStatus('자동충전 설정 중 네트워크 오류가 발생했습니다.');
    }
  }

  async function handleDrop(files: FileList | null) {
    if (!files || files.length === 0) return;

    const form = new FormData();
    if (selectedProject?.id) form.set('projectId', selectedProject.id);
    form.set('redirectTo', '/');

    for (const file of Array.from(files)) {
      if (!form.get('pdf') && (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'))) {
        form.set('pdf', file);
        setPdfName(file.name);
        continue;
      }
      if (!form.get('audio') && file.type.startsWith('audio/')) {
        form.set('audio', file);
        setAudioName(file.name);
      }
    }

    if (!form.get('pdf') && !form.get('audio')) return;

    const response = await fetch('/api/ingest', { method: 'POST', body: form, redirect: 'follow' });
    if (response.redirected) {
      window.location.assign(response.url);
      return;
    }
    router.refresh();
  }

  async function handleGenerateSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isGenerating) return;

    setIsGenerating(true);
    setGenerationStatus('생성 시작');
    setLiveNotes([]);

    let stepIndex = 0;
    const timer = window.setInterval(() => {
      setLiveNotes((prev) => {
        if (stepIndex >= progressLines.length) return prev;
        const next = [...prev, progressLines[stepIndex]];
        stepIndex += 1;
        return next;
      });
    }, 1200);

    try {
      const formData = new FormData(event.currentTarget);
      const response = await fetch('/api/generate', { method: 'POST', body: formData, redirect: 'follow' });

      if (response.redirected) {
        setGenerationStatus('생성 완료');
        setLiveNotes((prev) => [...prev, '필기 생성이 완료되어 미리보기를 갱신합니다.']);
        window.location.assign(response.url);
        return;
      }

      if (!response.ok) {
        const raw = await response.text().catch(() => '');
        let message = '생성 중 오류가 발생했습니다.';

        if (raw) {
          try {
            const payload = JSON.parse(raw) as { error?: unknown };
            if (typeof payload.error === 'string') {
              message = payload.error;
            } else if (payload.error) {
              message = JSON.stringify(payload.error);
            }
          } catch {
            message = raw.slice(0, 240);
          }
        }

        setGenerationStatus(message);
        return;
      }

      setGenerationStatus('생성 완료');
      router.refresh();
    } catch {
      setGenerationStatus('생성 중 네트워크 오류가 발생했습니다.');
    } finally {
      window.clearInterval(timer);
      setIsGenerating(false);
    }
  }

  function onAttachmentChange(event: ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files ? Array.from(event.target.files) : [];
    setAttachmentNames(picked.map((file) => file.name));
  }

  async function toggleTranslation() {
    if (!selectedProject?.id) return;

    if (translationMode === 'translated') {
      setTranslationMode('original');
      return;
    }

    setTranslationMode('translated');
    if (translationLines.length) return;

    setTranslationLoading(true);
    setTranslationStatus('');
    try {
      const response = await fetch(`/api/projects/${selectedProject.id}/translate`, { method: 'GET' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setTranslationStatus(typeof payload?.error === 'string' ? payload.error : '번역을 불러오지 못했습니다.');
        return;
      }
      if (!payload?.detected) {
        setTranslationStatus('번역할 문장을 찾지 못했습니다.');
        return;
      }
      setTranslationLines(Array.isArray(payload.lines) ? payload.lines : []);
      if (!payload.lines?.length) {
        setTranslationStatus('번역할 문장을 찾지 못했습니다.');
      }
    } catch {
      setTranslationStatus('번역 요청 중 네트워크 오류가 발생했습니다.');
    } finally {
      setTranslationLoading(false);
    }
  }

  async function saveProjectTitle() {
    if (!selectedProject?.id) return;
    const nextTitle = titleDraft.trim();
    if (!nextTitle) {
      setTitleError('제목을 입력해 주세요.');
      setTitleErrorTick((prev) => prev + 1);
      return;
    }

    setTitleSaving(true);
    setTitleError('');
    try {
      const response = await fetch(`/api/projects/${selectedProject.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: nextTitle }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setTitleError(typeof payload?.error === 'string' ? payload.error : '제목을 저장하지 못했습니다.');
        setTitleErrorTick((prev) => prev + 1);
        return;
      }

      setEditingTitle(false);
      router.refresh();
    } catch {
      setTitleError('네트워크 오류로 제목 저장에 실패했습니다.');
      setTitleErrorTick((prev) => prev + 1);
    } finally {
      setTitleSaving(false);
    }
  }

  return (
    <div
      className={`workspaceLayout ${sidebarCollapsed ? 'sidebarHidden' : ''} ${sidebarResizing ? 'isResizing' : ''}`}
      style={{ ['--sidebar-width' as string]: `${sidebarWidth}px` }}
    >
      {sidebarCollapsed ? (
        <button
          className="iconButton sidebarToggleTitleLeft"
          type="button"
          aria-label="사이드바 펼치기"
          onClick={() => {
            setSidebarCollapsed(false);
            if (sidebarWidth < SIDEBAR_MIN) setSidebarWidth(300);
          }}
        >
          <ChevronRight size={18} />
        </button>
      ) : null}

      {!sidebarCollapsed ? (
      <aside ref={sidebarRef} className="sidebar card">
        <div className="sidebarTopLeft">
          <div className="sidebarHeading">프로젝트</div>
          <div className="sidebarTopControls">
            <form action="/api/projects" method="post">
              <input type="hidden" name="title" value="새 프로젝트" />
              <input type="hidden" name="subject" value="" />
              <input type="hidden" name="description" value="홈 화면에서 시작한 빈 프로젝트" />
              <button className="iconButton" type="submit" aria-label="새 프로젝트 만들기">
                <Plus size={16} />
              </button>
            </form>
            <button
              className="iconButton sidebarToggleAttached"
              type="button"
              aria-label="사이드바 접기"
              onClick={() => setSidebarCollapsed(true)}
            >
              <ChevronLeft size={18} />
            </button>
          </div>
        </div>
        <div className="sidebarList">
          {projects.map((project) => (
            <Link
              key={project.id}
              href={`/?projectId=${project.id}`}
              className={`sidebarItem ${selectedProject?.id === project.id ? 'active' : ''}`}
              title={project.title}
            >
              <div className="sidebarItemTitle">{project.title}</div>
              <div className="sidebarItemMeta">
                <span>{project.subject || '과목 자동 분석'}</span>
                <span>자료 {project.assetCount}</span>
              </div>
            </Link>
          ))}
          {!projects.length ? <div className="emptyHint">아직 프로젝트가 없습니다.</div> : null}
        </div>
        <div
          className="sidebarResizer"
          role="separator"
          aria-label="사이드바 크기 조절"
          onMouseDown={(event) => {
            event.preventDefault();
            setSidebarResizing(true);
          }}
        />
      </aside>
      ) : null}

      <section className="workspaceMain">
        <div className="topBar card">
          <div className="titleArea">
            <div className="label">현재 작업 공간</div>
            <div className="workspaceTitleRow">
              {editingTitle ? (
                <form
                  className="titleInlineForm"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveProjectTitle();
                  }}
                >
                  <input
                    className="input titleEditInput"
                    value={titleDraft}
                    onChange={(event) => setTitleDraft(event.target.value)}
                    onBlur={() => {
                      void saveProjectTitle();
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void saveProjectTitle();
                      }
                    }}
                    disabled={titleSaving}
                    autoFocus
                  />
                </form>
              ) : (
                <>
                  <div className="workspaceTitle">{selectedProject?.title || '새 업로드 또는 메모로 시작하기'}</div>
                  {selectedProject?.id ? (
                    <button className="iconButton" type="button" onClick={() => setEditingTitle(true)} aria-label="제목 수정">
                      <Pencil size={16} />
                    </button>
                  ) : null}
                </>
              )}
            </div>
            {titleError ? <div key={titleErrorTick} className="titleError titleErrorShake">{titleError}</div> : null}
            <div className="muted">{selectedProject?.description || 'PDF를 드래그해서 넣고, 입력창에 요청을 적은 뒤 생성을 누르면 됩니다.'}</div>
            {pdfName ? <div className="fileBadge">최근 드롭 PDF · {pdfName}</div> : null}
            {audioName ? <div className="fileBadge">최근 드롭 오디오 · {audioName}</div> : null}
          </div>
          <div className="topBarActions">
            <AuthControls />
            <div className="billingMini">
              <div className="billingBalance">크레딧 {loadingBalance ? '불러오는 중...' : Number(creditBalance || '0').toLocaleString()}</div>
              <button className="button secondary" type="button" onClick={() => void quickCharge()}>
                + 충전
              </button>
              <label className="autoRechargeToggle">
                <input
                  type="checkbox"
                  checked={autoRechargeEnabled}
                  onChange={(event) => {
                    void toggleAutoRecharge(event.target.checked);
                  }}
                />
                자동충전
              </label>
            </div>
          </div>
        </div>
        {billingStatus ? <div className="muted">{billingStatus}</div> : null}

        <div className="workspaceStudio">
          <div
            className={`card stack previewCard ${workspaceView === 'quiz' ? 'quizCard' : ''}`}
            onDragEnter={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              if (e.currentTarget === e.target) setDragging(false);
            }}
            onDrop={async (e) => {
              e.preventDefault();
              e.stopPropagation();
              setDragging(false);
              await handleDrop(e.dataTransfer.files);
            }}
          >
            <div className="previewHeader">
              <div className="sectionTitle">업로드 자료 미리보기</div>
              {previewPdfUrl ? (
                <button
                  className="button secondary"
                  type="button"
                  onClick={toggleTranslation}
                  disabled={translationLoading}
                  title={translationMode === 'translated' ? '원문 보기로 전환' : '한국어 번역 보기'}
                >
                  <Languages size={16} />
                  {translationMode === 'translated' ? '원문 보기' : '번역'}
                </button>
              ) : null}
            </div>
            {dragging ? <div className="previewDropOverlay">여기에 PDF를 놓으면 중앙 미리보기에 업로드됩니다</div> : null}

            {workspaceView === 'notes' && (isGenerating || liveNotes.length > 0) ? (
              <div className="liveNotePanel">
                <div className="label">실시간 필기</div>
                {liveNotes.length ? (
                  liveNotes.map((line, idx) => <div key={`${line}-${idx}`} className="liveNoteLine">{line}</div>)
                ) : (
                  <div className="liveNoteLine">필기 생성을 준비하고 있습니다...</div>
                )}
              </div>
            ) : null}

            {previewPdfUrl ? (
              <div className="previewFrameWrap">
                <iframe className="previewFrame" src={previewPdfUrl} title="PDF 미리보기" />
              </div>
            ) : (
              <div className="dropZone previewEmpty">
                <UploadCloud size={26} />
                <div className="dropZoneTitle">PDF를 드롭하면 여기에 미리보기가 표시됩니다</div>
              </div>
            )}

            {translationMode === 'translated' ? (
              <div className="translationPanel">
                <div className="sectionTitle">번역 결과 (한국어)</div>
                {translationLoading ? <div className="muted">번역을 불러오는 중...</div> : null}
                {translationStatus ? <div className="muted">{translationStatus}</div> : null}
                {translationLines.map((line, idx) => (
                  <div key={`${line.original}-${idx}`} className="translationLine">
                    <div className="translationOriginal">{line.original}</div>
                    <div className="translationSub">{line.translation}</div>
                  </div>
                ))}
              </div>
            ) : null}

            {workspaceView === 'quiz' ? (
              <>
                <div className="quizHeader">
                  <div className="sectionTitle">시험 대비 퀴즈</div>
                </div>

                {selectedProject?.lastRun?.summary ? (
                  <div className="quizSummary">{selectedProject.lastRun.summary}</div>
                ) : null}

                {quizItems.length ? (
                  <div className="quizList">
                    {quizItems.map((item, idx) => (
                      <div key={`${idx}-${item.question}`} className="quizItem">
                        <div className="quizQ">Q{idx + 1}. {item.question}</div>
                        <div className="quizHint">힌트: {item.hint || '핵심 키워드 3개를 먼저 적고, 개념 간 차이를 연결해 보세요.'}</div>
                        <div className="quizA">정답 포인트: {item.answer}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="dropZone">
                    <div className="dropZoneTitle">퀴즈가 아직 없습니다</div>
                    <div className="muted">PDF 업로드 후 생성을 누르면 중요한 부분 중심으로 시험 대비 퀴즈가 만들어집니다.</div>
                  </div>
                )}
              </>
            ) : null}
          </div>

          <form className="card stack chatPanel" method="post" encType="multipart/form-data" onSubmit={handleGenerateSubmit}>
            <input type="hidden" name="projectId" value={selectedProject?.id || ''} />
            <input type="hidden" name="redirectTo" value="/" />
            <input type="hidden" name="customNotes" value="" />

            <div className="viewToggle" role="tablist" aria-label="작업 보기 전환">
              <button
                type="button"
                role="tab"
                aria-selected={workspaceView === 'notes'}
                className={`viewToggleButton ${workspaceView === 'notes' ? 'active' : ''}`}
                onClick={() => setWorkspaceView('notes')}
              >
                필기
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={workspaceView === 'quiz'}
                className={`viewToggleButton ${workspaceView === 'quiz' ? 'active' : ''}`}
                onClick={() => setWorkspaceView('quiz')}
              >
                퀴즈
              </button>
            </div>

            <div className="composerRow">
              <textarea
                className="textarea composerInput"
                name="noteText"
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                placeholder="예: 교수님이 역전파 유도 과정과 Transformer attention 계산을 중요하다고 했어. 표와 흐름도로 같이 정리해줘"
                disabled={isGenerating}
              />
            </div>

            <div className="composerActions">
              <button
                type="button"
                className="iconButton clipButton"
                onClick={() => attachmentRef.current?.click()}
                aria-label="파일 첨부"
                title="오디오/텍스트/PDF 첨부"
                disabled={isGenerating}
              >
                <Paperclip size={18} />
              </button>
              <button className="button" type="submit" disabled={isGenerating}>
                {isGenerating ? '생성 중...' : '생성'}
              </button>
            </div>

            <input
              ref={attachmentRef}
              className="hiddenInput"
              type="file"
              name="attachments"
              multiple
              accept="audio/*,text/*,.txt,.md,.csv,.json,.yaml,.yml,.rtf,application/pdf"
              onChange={onAttachmentChange}
            />

            {attachmentNames.length ? (
              <div className="attachmentList">
                {attachmentNames.map((name, idx) => (
                  <div key={`${name}-${idx}`} className="attachmentChip">
                    <span>{name}</span>
                  </div>
                ))}
              </div>
            ) : null}

            {generationStatus ? <div className="muted">상태: {generationStatus}</div> : null}

            <div className="row">
              {quickPrompts.map((prompt) => (
                <button key={prompt} className="chip" type="button" onClick={() => setNoteDraft((prev) => (prev ? `${prev}\n${prompt}` : prompt))} disabled={isGenerating}>
                  {prompt}
                </button>
              ))}
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}
