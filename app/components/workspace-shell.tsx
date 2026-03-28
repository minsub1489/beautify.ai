'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight, Languages, Paperclip, Pencil, Plus, Trash2, UploadCloud } from 'lucide-react';
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
  createdAt?: string;
};

type RunSummary = {
  summary?: string | null;
  outputUrl?: string | null;
  examFocusJson?: unknown;
  notesByPageJson?: unknown;
  visualsJson?: unknown;
  questionsJson?: unknown;
  createdAt?: string;
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
  type: 'short' | 'ox' | 'mcq';
  question: string;
  answer: string;
  hint?: string;
  source?: string;
  options?: string[];
  correctOptionIndex?: number;
};

type PageNoteItem = {
  page: number;
  notes: string;
};

type PageEditorItem = {
  id: string;
  sourcePage: number;
};

type WrongAnswerNote = {
  question: string;
  type: QuizItem['type'];
  userAnswer: string;
  correctAnswer: string;
  hint?: string;
};

type QuizAnswerStatus = 'unanswered' | 'correct' | 'wrong';

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
          type: 'short',
          question,
          answer: '생성된 필기와 요약을 참고해 스스로 답해보세요.',
          hint: '핵심 용어 정의, 비교 포인트, 적용 예시를 함께 떠올려 보세요.',
        };
      }

      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      const rawType = sanitizeText(record.type).toLowerCase();
      const question = sanitizeText(record.question);
      const answer = sanitizeText(record.answer, '정답 요약이 제공되지 않았습니다.');
      const hint = sanitizeText(record.hint);
      const source = sanitizeText(record.source);
      const options = Array.isArray(record.options)
        ? record.options.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean)
        : [];
      const normalizedAnswer = answer.toUpperCase();
      const inferredType: QuizItem['type'] =
        rawType === 'ox' || rawType === 'mcq' || rawType === 'short'
          ? rawType
          : options.length >= 2
            ? 'mcq'
            : normalizedAnswer === 'O' || normalizedAnswer === 'X'
              ? 'ox'
              : 'short';
      const correctOptionIndex = typeof record.correctOptionIndex === 'number' && Number.isInteger(record.correctOptionIndex)
        ? record.correctOptionIndex
        : -1;
      if (!question) return null;
      return {
        type: inferredType === 'mcq' && options.length < 2 ? 'short' : inferredType,
        question,
        answer,
        hint: hint || undefined,
        source: source || undefined,
        options: options.length ? options.slice(0, 4) : undefined,
        correctOptionIndex: correctOptionIndex >= 0 && correctOptionIndex <= 3 ? correctOptionIndex : undefined,
      };
    })
    .filter((item): item is QuizItem => Boolean(item));
  return parsed;
}

function parsePageNotes(raw: unknown): PageNoteItem[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .map((item): PageNoteItem | null => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      const page = typeof record.page === 'number' ? record.page : Number(record.page);
      const notes = sanitizeText(record.notes);
      if (!Number.isFinite(page) || page <= 0 || !notes) return null;
      return { page, notes };
    })
    .filter((item): item is PageNoteItem => Boolean(item))
    .sort((a, b) => a.page - b.page);
}

function normalizeForCompare(text: string) {
  return (text || '').toLowerCase().replace(/\s+/g, '').replace(/[.,!?'"`()[\]{}:;/-]/g, '');
}

function rotateOptions(options: string[], shift: number) {
  if (!options.length) return options;
  const n = options.length;
  const s = ((shift % n) + n) % n;
  if (s === 0) return [...options];
  return [...options.slice(s), ...options.slice(0, s)];
}

function makeVariantQuizItem(item: QuizItem, seed: number): QuizItem {
  if (item.type === 'mcq' && item.options?.length) {
    const originalCorrect = typeof item.correctOptionIndex === 'number' ? item.correctOptionIndex : 0;
    const rotated = rotateOptions(item.options, seed % item.options.length || 1);
    const correctAnswerText = item.options[originalCorrect] || item.answer;
    const newCorrectIndex = Math.max(0, rotated.findIndex((option) => option === correctAnswerText));
    return {
      ...item,
      question: `[변형] ${item.question} (같은 개념, 다른 보기 구성)`,
      options: rotated,
      correctOptionIndex: newCorrectIndex,
      answer: correctAnswerText,
    };
  }

  if (item.type === 'ox') {
    return {
      ...item,
      question: `[변형] ${item.question} (판단 근거를 한 줄로 덧붙이세요)`,
    };
  }

  return {
    ...item,
    question: `[변형] ${item.question}를 다른 상황(예시/비교)으로 다시 설명하세요.`,
  };
}

function isQuizAnswerCorrect(item: QuizItem, userAnswer: string) {
  const normalizedUser = normalizeForCompare(userAnswer);
  if (!normalizedUser) return false;

  if (item.type === 'ox') {
    const normalizedCorrect = normalizeForCompare(item.answer);
    const isO = normalizedCorrect === 'o' || normalizedCorrect.includes('맞');
    const isX = normalizedCorrect === 'x' || normalizedCorrect.includes('틀');
    if (isO) return normalizedUser === 'o';
    if (isX) return normalizedUser === 'x';
    return normalizedUser === normalizedCorrect;
  }

  if (item.type === 'mcq') {
    if (typeof item.correctOptionIndex === 'number' && item.options?.[item.correctOptionIndex]) {
      return normalizedUser === normalizeForCompare(item.options[item.correctOptionIndex]);
    }
    if (item.options?.length) {
      return item.options.some((option) => normalizeForCompare(option) === normalizedUser && normalizeForCompare(item.answer).includes(normalizedUser));
    }
  }

  const normalizedCorrect = normalizeForCompare(item.answer);
  return normalizedCorrect.includes(normalizedUser) || normalizedUser.includes(normalizedCorrect);
}

function getQuizAnswerStatus(item: QuizItem | undefined, userAnswer: string) {
  if (!item) return 'unanswered' as const;
  if (!userAnswer.trim()) return 'unanswered' as const;
  return isQuizAnswerCorrect(item, userAnswer) ? 'correct' as const : 'wrong' as const;
}

function createPageEditorItem(sourcePage: number): PageEditorItem {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${sourcePage}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    sourcePage,
  };
}

function getPageOrderSignature(items: PageEditorItem[]) {
  return items.map((item) => item.sourcePage).join(',');
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
  const [translationLoading, setTranslationLoading] = useState(false);
  const [translationStatus, setTranslationStatus] = useState('');
  const [translatedAssetId, setTranslatedAssetId] = useState('');
  const [pdfRemoving, setPdfRemoving] = useState(false);
  const [pdfRemoveStatus, setPdfRemoveStatus] = useState('');
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
  const [regeneratingPage, setRegeneratingPage] = useState<number | null>(null);
  const [pageRegenerationStatus, setPageRegenerationStatus] = useState('');
  const [quizAnswers, setQuizAnswers] = useState<Record<number, string>>({});
  const [quizSubmitted, setQuizSubmitted] = useState(false);
  const [wrongNotes, setWrongNotes] = useState<WrongAnswerNote[]>([]);
  const [retryQuizMode, setRetryQuizMode] = useState(false);
  const [retryQuizItems, setRetryQuizItems] = useState<QuizItem[]>([]);
  const [currentQuizIndex, setCurrentQuizIndex] = useState(0);
  const [quizAutoGenerating, setQuizAutoGenerating] = useState(false);
  const [quizAutoStatus, setQuizAutoStatus] = useState('');
  const [quizAutoTriggeredFor, setQuizAutoTriggeredFor] = useState('');
  const [pdfPageItems, setPdfPageItems] = useState<PageEditorItem[]>([]);
  const [pdfPageInitialOrder, setPdfPageInitialOrder] = useState<number[]>([]);
  const [pdfPageClipboard, setPdfPageClipboard] = useState<number | null>(null);
  const [pdfPageLoading, setPdfPageLoading] = useState(false);
  const [pdfPageSaving, setPdfPageSaving] = useState(false);
  const [pdfPageStatus, setPdfPageStatus] = useState('');

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
      '시험 포인트와 퀴즈를 구성하는 중...',
      '미리보기용 필기를 PDF 위에 반영하는 중...',
    ],
    [],
  );

  const quizItems = useMemo(() => parseQuizItems(selectedProject?.lastRun?.questionsJson), [selectedProject?.lastRun?.questionsJson]);
  const pageNotes = useMemo(() => parsePageNotes(selectedProject?.lastRun?.notesByPageJson), [selectedProject?.lastRun?.notesByPageJson]);
  const activeQuizItems = useMemo(() => (retryQuizMode ? retryQuizItems : quizItems), [quizItems, retryQuizItems, retryQuizMode]);
  const currentQuizItem = activeQuizItems[currentQuizIndex];
  const currentQuizAnswer = quizAnswers[currentQuizIndex] || '';
  const currentQuizStatus = getQuizAnswerStatus(currentQuizItem, currentQuizAnswer);
  const answeredCount = activeQuizItems.filter((_, idx) => (quizAnswers[idx] || '').trim()).length;
  const remainingCount = Math.max(0, activeQuizItems.length - answeredCount);
  const currentPdfPageCount = pdfPageItems.length;
  const pdfPageDirty = useMemo(
    () => getPageOrderSignature(pdfPageItems) !== pdfPageInitialOrder.join(','),
    [pdfPageInitialOrder, pdfPageItems],
  );
  const hasPdfAsset = useMemo(() => Boolean(selectedProject?.assets?.some((asset) => asset.kind === 'pdf')), [selectedProject?.assets]);
  const latestPdfAsset = useMemo(() => {
    if (!selectedProject?.assets?.length) return null;
    return [...selectedProject.assets]
      .filter((asset) => asset.kind === 'pdf')
      .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())[0] || null;
  }, [selectedProject?.assets]);
  const latestPdfCreatedAt = useMemo(() => {
    if (!selectedProject?.assets?.length) return 0;
    return selectedProject.assets
      .filter((asset) => asset.kind === 'pdf')
      .reduce((latest, asset) => Math.max(latest, new Date(asset.createdAt || 0).getTime()), 0);
  }, [selectedProject?.assets]);
  const latestRunCreatedAt = useMemo(
    () => (selectedProject?.lastRun?.createdAt ? new Date(selectedProject.lastRun.createdAt).getTime() : 0),
    [selectedProject?.lastRun?.createdAt],
  );

  const basePreviewPdfUrl = useMemo(() => {
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

  const previewPdfUrl = useMemo(() => {
    if (translationMode === 'translated' && translatedAssetId) {
      return `/api/assets/${translatedAssetId}/raw`;
    }
    return basePreviewPdfUrl;
  }, [basePreviewPdfUrl, translatedAssetId, translationMode]);

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
    setTranslatedAssetId('');
    setTranslationLoading(false);
    setTranslationStatus('');
    setPdfRemoving(false);
    setPdfRemoveStatus('');
    setRegeneratingPage(null);
    setPageRegenerationStatus('');
    setPdfPageItems([]);
    setPdfPageInitialOrder([]);
    setPdfPageClipboard(null);
    setPdfPageLoading(false);
    setPdfPageSaving(false);
    setPdfPageStatus('');
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
    setQuizAnswers({});
    setQuizSubmitted(false);
    setWrongNotes([]);
    setRetryQuizMode(false);
    setRetryQuizItems([]);
    setCurrentQuizIndex(0);
    setQuizAutoGenerating(false);
    setQuizAutoStatus('');
    setQuizAutoTriggeredFor('');
  }, [selectedProject?.id, selectedProject?.lastRun?.questionsJson]);

  useEffect(() => {
    if (!activeQuizItems.length) {
      setCurrentQuizIndex(0);
      return;
    }
    if (currentQuizIndex > activeQuizItems.length - 1) {
      setCurrentQuizIndex(activeQuizItems.length - 1);
    }
  }, [activeQuizItems.length, currentQuizIndex]);

  useEffect(() => {
    let active = true;
    const assetId = latestPdfAsset?.id;

    if (!assetId) {
      setPdfPageItems([]);
      setPdfPageInitialOrder([]);
      setPdfPageClipboard(null);
      setPdfPageSaving(false);
      setPdfPageStatus('');
      setPdfPageLoading(false);
      return () => {
        active = false;
      };
    }

    async function loadPdfPages() {
      setPdfPageLoading(true);
      setPdfPageClipboard(null);
      setPdfPageStatus('');
      try {
        const response = await fetch(`/api/assets/${assetId}/pages`);
        const payload = await response.json().catch(() => ({}));
        if (!active) return;

        if (!response.ok) {
          setPdfPageItems([]);
          setPdfPageInitialOrder([]);
          setPdfPageStatus(typeof payload?.error === 'string' ? payload.error : 'PDF 페이지 정보를 불러오지 못했습니다.');
          return;
        }

        const pageCount = Number(payload?.pageCount);
        if (!Number.isFinite(pageCount) || pageCount <= 0) {
          setPdfPageItems([]);
          setPdfPageInitialOrder([]);
          setPdfPageStatus('PDF 페이지 정보를 읽을 수 없습니다.');
          return;
        }

        const nextOrder = Array.from({ length: pageCount }, (_, index) => index + 1);
        setPdfPageInitialOrder(nextOrder);
        setPdfPageItems(nextOrder.map((page) => createPageEditorItem(page)));
      } catch {
        if (!active) return;
        setPdfPageItems([]);
        setPdfPageInitialOrder([]);
        setPdfPageStatus('PDF 페이지 정보를 불러오는 중 네트워크 오류가 발생했습니다.');
      } finally {
        if (active) setPdfPageLoading(false);
      }
    }

    void loadPdfPages();
    return () => {
      active = false;
    };
  }, [latestPdfAsset?.id]);

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
    if (!selectedProject?.id || !basePreviewPdfUrl) return;

    if (translationMode === 'translated') {
      setTranslationMode('original');
      return;
    }

    setTranslationMode('translated');
    if (translatedAssetId) return;

    setTranslationLoading(true);
    setTranslationStatus('');
    try {
      const response = await fetch(`/api/projects/${selectedProject.id}/translate-pdf`, { method: 'POST' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setTranslationStatus(typeof payload?.error === 'string' ? payload.error : '번역을 불러오지 못했습니다.');
        setTranslationMode('original');
        return;
      }
      if (!payload?.assetId || typeof payload.assetId !== 'string') {
        setTranslationStatus('번역 PDF를 생성하지 못했습니다.');
        setTranslationMode('original');
        return;
      }
      setTranslatedAssetId(payload.assetId);
      setTranslationStatus('번역된 PDF를 적용했습니다.');
    } catch {
      setTranslationStatus('번역 요청 중 네트워크 오류가 발생했습니다.');
      setTranslationMode('original');
    } finally {
      setTranslationLoading(false);
    }
  }

  async function removeLatestPdf() {
    if (!latestPdfAsset?.id || pdfRemoving) return;

    const confirmed = window.confirm('현재 업로드된 PDF를 제거할까요? 이 PDF로 만든 필기, 퀴즈, 번역본도 함께 정리됩니다.');
    if (!confirmed) return;

    setPdfRemoving(true);
    setPdfRemoveStatus('');
    try {
      const response = await fetch(`/api/assets/${latestPdfAsset.id}`, { method: 'DELETE' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setPdfRemoveStatus(typeof payload?.error === 'string' ? payload.error : 'PDF를 제거하지 못했습니다.');
        return;
      }

      setTranslationMode('original');
      setTranslatedAssetId('');
      setQuizAutoStatus('');
      setPdfRemoveStatus('업로드된 PDF를 제거했습니다.');
      router.refresh();
    } catch {
      setPdfRemoveStatus('PDF 제거 중 네트워크 오류가 발생했습니다.');
    } finally {
      setPdfRemoving(false);
    }
  }

  async function regeneratePageNote(page: number) {
    if (!selectedProject?.id || regeneratingPage !== null) return;

    setRegeneratingPage(page);
    setPageRegenerationStatus(`${page}페이지 필기를 다시 생성하는 중...`);
    try {
      const response = await fetch(`/api/projects/${selectedProject.id}/notes/regenerate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ page }),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setPageRegenerationStatus(typeof payload?.error === 'string' ? payload.error : '페이지 필기를 다시 생성하지 못했습니다.');
        return;
      }

      setTranslatedAssetId('');
      setTranslationMode('original');
      setPageRegenerationStatus(`${page}페이지 필기를 다시 생성했습니다.`);
      router.refresh();
    } catch {
      setPageRegenerationStatus('페이지 필기 재생성 중 네트워크 오류가 발생했습니다.');
    } finally {
      setRegeneratingPage(null);
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

  function movePdfPage(index: number, direction: -1 | 1) {
    setPdfPageItems((prev) => {
      const nextIndex = index + direction;
      if (index < 0 || index >= prev.length || nextIndex < 0 || nextIndex >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(index, 1);
      next.splice(nextIndex, 0, moved);
      return next;
    });
    setPdfPageStatus('');
  }

  function copyPdfPage(sourcePage: number) {
    setPdfPageClipboard(sourcePage);
    setPdfPageStatus(`원본 ${sourcePage}페이지를 복사했습니다.`);
  }

  function pastePdfPage(afterIndex: number) {
    if (!pdfPageClipboard) return;

    setPdfPageItems((prev) => {
      const next = [...prev];
      next.splice(afterIndex + 1, 0, createPageEditorItem(pdfPageClipboard));
      return next;
    });
    setPdfPageStatus(`원본 ${pdfPageClipboard}페이지를 붙여넣었습니다.`);
  }

  function deletePdfPage(index: number) {
    setPdfPageItems((prev) => {
      if (prev.length <= 1) {
        setPdfPageStatus('마지막 1페이지는 남겨둬야 합니다.');
        return prev;
      }
      setPdfPageStatus('');
      return prev.filter((_, itemIndex) => itemIndex !== index);
    });
  }

  function resetPdfPageEdits() {
    setPdfPageItems(pdfPageInitialOrder.map((page) => createPageEditorItem(page)));
    setPdfPageStatus('페이지 구성을 원본 순서로 되돌렸습니다.');
  }

  async function applyPdfPageEdits() {
    if (!selectedProject?.id || !pdfPageDirty || pdfPageSaving) return;

    const confirmed = window.confirm('페이지 편집을 적용하면 현재 필기, 퀴즈, 번역 결과가 초기화됩니다. 계속할까요?');
    if (!confirmed) return;

    setPdfPageSaving(true);
    setPdfPageStatus('편집한 페이지 순서로 새 PDF를 만드는 중...');
    try {
      const response = await fetch(`/api/projects/${selectedProject.id}/pdf-pages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pageOrder: pdfPageItems.map((item) => item.sourcePage),
        }),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setPdfPageStatus(typeof payload?.error === 'string' ? payload.error : 'PDF 페이지 편집을 적용하지 못했습니다.');
        return;
      }

      setTranslationMode('original');
      setTranslatedAssetId('');
      setTranslationStatus('');
      setQuizAnswers({});
      setQuizSubmitted(false);
      setWrongNotes([]);
      setRetryQuizMode(false);
      setRetryQuizItems([]);
      setCurrentQuizIndex(0);
      setQuizAutoTriggeredFor('');
      setQuizAutoStatus('');
      setPageRegenerationStatus('');
      setPdfPageStatus('페이지 편집을 적용했습니다. 최신 PDF로 화면을 갱신합니다.');
      router.refresh();
    } catch {
      setPdfPageStatus('PDF 페이지 편집 적용 중 네트워크 오류가 발생했습니다.');
    } finally {
      setPdfPageSaving(false);
    }
  }

  function setQuizAnswer(index: number, value: string) {
    setQuizAnswers((prev) => ({ ...prev, [index]: value }));
  }

  function finishQuiz() {
    const wrong: WrongAnswerNote[] = [];
    activeQuizItems.forEach((item, idx) => {
      const userAnswer = (quizAnswers[idx] || '').trim();
      const correct = isQuizAnswerCorrect(item, userAnswer);
      if (correct) return;
      wrong.push({
        question: item.question,
        type: item.type,
        userAnswer: userAnswer || '(미입력)',
        correctAnswer:
          item.type === 'mcq' && typeof item.correctOptionIndex === 'number' && item.options?.[item.correctOptionIndex]
            ? item.options[item.correctOptionIndex]
            : item.answer,
        hint: item.hint,
      });
    });

    setWrongNotes(wrong);
    setQuizSubmitted(true);
  }

  function goToNextQuiz() {
    if (currentQuizIndex >= activeQuizItems.length - 1) {
      finishQuiz();
      return;
    }
    setCurrentQuizIndex((prev) => Math.min(prev + 1, activeQuizItems.length - 1));
  }

  function goToPreviousQuiz() {
    setCurrentQuizIndex((prev) => Math.max(prev - 1, 0));
  }

  function startWrongRetryExam() {
    const wrongSet = new Set(wrongNotes.map((note) => note.question));
    const variants = quizItems
      .filter((item) => wrongSet.has(item.question))
      .map((item, idx) => makeVariantQuizItem(item, idx + 1));
    setRetryQuizItems(variants);
    setRetryQuizMode(true);
    setQuizSubmitted(false);
    setQuizAnswers({});
    setCurrentQuizIndex(0);
  }

  function resetFullQuiz() {
    setRetryQuizMode(false);
    setRetryQuizItems([]);
    setQuizSubmitted(false);
    setQuizAnswers({});
    setCurrentQuizIndex(0);
  }

  async function autoGenerateQuiz() {
    if (!selectedProject?.id || quizAutoGenerating) return;
    const triggerKey = `${selectedProject.id}:${latestPdfCreatedAt || 'no-pdf'}`;
    setQuizAutoGenerating(true);
    setQuizAutoStatus('PDF 핵심 내용을 분석해 퀴즈를 만드는 중...');
    setQuizAutoTriggeredFor(triggerKey);
    try {
      const formData = new FormData();
      formData.set('projectId', selectedProject.id);
      formData.set('redirectTo', `/?projectId=${selectedProject.id}`);
      formData.set(
        'noteText',
        '최신 PDF 본문을 실제로 분석해서 가장 중요한 내용만 골라 한국어 퀴즈 4~5개를 만들어줘. 각 문제는 자료 근거(source)가 보여야 하고, 단답형/OX/4지선다를 섞어줘.',
      );
      formData.set('customNotes', '');

      const response = await fetch('/api/generate', {
        method: 'POST',
        body: formData,
        redirect: 'follow',
      });

      if (response.redirected) {
        window.location.assign(response.url);
        return;
      }

      if (!response.ok) {
        const raw = await response.text().catch(() => '');
        let message = '퀴즈 자동 생성 중 오류가 발생했습니다.';
        if (raw) {
          try {
            const payload = JSON.parse(raw) as { error?: unknown };
            if (typeof payload.error === 'string') message = payload.error;
          } catch {
            message = raw.slice(0, 180);
          }
        }
        setQuizAutoStatus(message);
        return;
      }

      setQuizAutoStatus('PDF 분석 기반 퀴즈가 준비되었습니다.');
      router.refresh();
    } catch {
      setQuizAutoStatus('퀴즈 자동 생성 중 네트워크 오류가 발생했습니다.');
    } finally {
      setQuizAutoGenerating(false);
    }
  }

  useEffect(() => {
    if (workspaceView !== 'quiz') return;
    if (!selectedProject?.id) return;
    if (!hasPdfAsset) {
      setQuizAutoStatus('퀴즈를 만들려면 먼저 PDF를 업로드해 주세요.');
      return;
    }
    const needsRegeneration =
      quizItems.length === 0 ||
      !latestRunCreatedAt ||
      (latestPdfCreatedAt > 0 && latestPdfCreatedAt > latestRunCreatedAt);

    if (!needsRegeneration) {
      setQuizAutoStatus('');
      return;
    }
    const triggerKey = `${selectedProject.id}:${latestPdfCreatedAt || 'no-pdf'}`;
    if (quizAutoTriggeredFor === triggerKey) return;
    void autoGenerateQuiz();
  }, [workspaceView, selectedProject?.id, hasPdfAsset, quizItems.length, latestPdfCreatedAt, latestRunCreatedAt, quizAutoTriggeredFor]);

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
            className="card stack previewCard"
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
              <div className="row">
                {previewPdfUrl ? (
                  <button
                    className="button secondary"
                    type="button"
                    onClick={toggleTranslation}
                    disabled={translationLoading && translationMode !== 'translated'}
                    title={translationMode === 'translated' ? '원문 보기로 전환' : '한국어 번역 보기'}
                  >
                    <Languages size={16} />
                    {translationLoading && translationMode !== 'translated'
                      ? '번역 중...'
                      : translationMode === 'translated'
                        ? '원문 보기'
                        : '번역'}
                  </button>
                ) : null}
                {latestPdfAsset ? (
                  <button
                    className="button danger"
                    type="button"
                    onClick={() => void removeLatestPdf()}
                    disabled={pdfRemoving}
                    title={`${latestPdfAsset.originalName} 제거`}
                  >
                    <Trash2 size={16} />
                    {pdfRemoving ? '제거 중...' : 'PDF 제거'}
                  </button>
                ) : null}
              </div>
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

            {translationStatus ? <div className="muted">{translationStatus}</div> : null}
            {pdfRemoveStatus ? <div className="muted">{pdfRemoveStatus}</div> : null}

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
            {workspaceView === 'notes' ? (
              <>
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
                {pageRegenerationStatus ? <div className="muted">상태: {pageRegenerationStatus}</div> : null}

                <div className="row">
                  {quickPrompts.map((prompt) => (
                    <button key={prompt} className="chip" type="button" onClick={() => setNoteDraft((prev) => (prev ? `${prev}\n${prompt}` : prompt))} disabled={isGenerating}>
                      {prompt}
                    </button>
                  ))}
                </div>

                {pageNotes.length ? (
                  <div className="pageNotePanel">
                    <div className="sectionTitle">페이지별 필기</div>
                    <div className="muted">마음에 들지 않는 페이지는 해당 페이지만 다시 생성할 수 있습니다.</div>
                    <div className="pageNoteList">
                      {pageNotes.map((item) => (
                        <div key={item.page} className="pageNoteItem">
                          <div className="pageNoteTop">
                            <div className="pageNoteTitle">{item.page}페이지</div>
                            <button
                              type="button"
                              className="button secondary"
                              disabled={regeneratingPage !== null}
                              onClick={() => void regeneratePageNote(item.page)}
                            >
                              {regeneratingPage === item.page ? '다시 생성 중...' : '이 페이지 다시 생성'}
                            </button>
                          </div>
                          <div className="pageNoteBody">{item.notes}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {latestPdfAsset ? (
                  <div className="pageEditorPanel">
                    <div className="pageEditorHeader">
                      <div>
                        <div className="sectionTitle">PDF 페이지 편집</div>
                        <div className="muted">현재 업로드된 원본 PDF를 기준으로 순서 변경, 삭제, 복사, 붙여넣기를 적용합니다.</div>
                      </div>
                      <div className="pageEditorCountBadge">총 {currentPdfPageCount}페이지</div>
                    </div>

                    <div className="pageEditorToolbar">
                      <div className="muted">
                        {pdfPageClipboard
                          ? `복사됨: 원본 ${pdfPageClipboard}페이지`
                          : '복사한 페이지가 없습니다.'}
                      </div>
                      <div className="row">
                        <button
                          type="button"
                          className="button secondary"
                          onClick={resetPdfPageEdits}
                          disabled={pdfPageLoading || pdfPageSaving || !pdfPageItems.length || !pdfPageDirty}
                        >
                          초기화
                        </button>
                        <button
                          type="button"
                          className="button"
                          onClick={() => void applyPdfPageEdits()}
                          disabled={pdfPageLoading || pdfPageSaving || !pdfPageItems.length || !pdfPageDirty}
                        >
                          {pdfPageSaving ? '적용 중...' : '변경 적용'}
                        </button>
                      </div>
                    </div>

                    {pdfPageLoading ? (
                      <div className="pageEditorEmpty">PDF 페이지를 불러오는 중...</div>
                    ) : pdfPageItems.length ? (
                      <div className="pageEditorList">
                        {pdfPageItems.map((item, index) => (
                          <div key={item.id} className="pageEditorItem">
                            <div className="pageEditorItemMain">
                              <div className="pageEditorTitle">현재 {index + 1}페이지</div>
                              <div className="pageEditorMeta">원본 {item.sourcePage}페이지</div>
                            </div>
                            <div className="pageEditorActions">
                              <button
                                type="button"
                                className="button secondary pageEditorButton"
                                onClick={() => movePdfPage(index, -1)}
                                disabled={pdfPageSaving || index === 0}
                              >
                                위로
                              </button>
                              <button
                                type="button"
                                className="button secondary pageEditorButton"
                                onClick={() => movePdfPage(index, 1)}
                                disabled={pdfPageSaving || index === pdfPageItems.length - 1}
                              >
                                아래로
                              </button>
                              <button
                                type="button"
                                className="button secondary pageEditorButton"
                                onClick={() => copyPdfPage(item.sourcePage)}
                                disabled={pdfPageSaving}
                              >
                                복사
                              </button>
                              <button
                                type="button"
                                className="button secondary pageEditorButton"
                                onClick={() => pastePdfPage(index)}
                                disabled={pdfPageSaving || !pdfPageClipboard}
                              >
                                붙여넣기 아래
                              </button>
                              <button
                                type="button"
                                className="button secondary pageEditorButton"
                                onClick={() => deletePdfPage(index)}
                                disabled={pdfPageSaving || pdfPageItems.length <= 1}
                              >
                                삭제
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="pageEditorEmpty">편집할 PDF 페이지를 찾지 못했습니다.</div>
                    )}

                    {pdfPageStatus ? <div className="muted">{pdfPageStatus}</div> : null}
                  </div>
                ) : null}

              </>
            ) : (
              <div className="quizTabPanel">
                <div className="quizAutoInline">
                  {retryQuizMode ? <div className="badge">오답 재시험</div> : <div className="muted">PDF 핵심만 추려 간단한 퀴즈를 만듭니다.</div>}
                  {quizAutoStatus ? <div className="muted">상태: {quizAutoStatus}</div> : null}
                  <button
                    type="button"
                    className="button secondary"
                    disabled={quizAutoGenerating || !selectedProject?.id || !hasPdfAsset}
                    onClick={() => {
                      setQuizAutoTriggeredFor('');
                      void autoGenerateQuiz();
                    }}
                  >
                    {quizAutoGenerating ? '퀴즈 생성 중...' : '다시 생성'}
                  </button>
                </div>

                {activeQuizItems.length ? (
                  <div className="quizSingleWrap">
                    <div className="quizProgressCard">
                      <div className="quizProgressTop">
                        <div className="quizProgressCount">문제 {currentQuizIndex + 1} / {activeQuizItems.length}</div>
                        <div className="quizProgressRemaining">남은 문제 {remainingCount}</div>
                      </div>
                      <div className="quizProgressBar">
                        <div
                          className="quizProgressFill"
                          style={{ width: `${activeQuizItems.length ? ((currentQuizIndex + 1) / activeQuizItems.length) * 100 : 0}%` }}
                        />
                      </div>
                      <div className="quizProgressMeta">
                        입력한 문제 {answeredCount}개
                      </div>
                    </div>

                    {currentQuizItem ? (
                      <div className="quizItem">
                        <div className="quizQ">Q{currentQuizIndex + 1}. {currentQuizItem.question}</div>
                        <div className="quizMeta">
                          유형: {currentQuizItem.type === 'mcq' ? '4지선다' : currentQuizItem.type === 'ox' ? 'OX' : '단답형'}
                        </div>
                        {currentQuizItem.source ? <div className="quizMeta">출제 근거: {currentQuizItem.source}</div> : null}
                        <div className="quizHint">힌트: {currentQuizItem.hint || 'PDF에서 해당 개념이 어떤 맥락으로 설명되는지 다시 떠올려 보세요.'}</div>

                        <div className={`quizLiveStatus ${currentQuizStatus}`}>
                          {currentQuizStatus === 'correct'
                            ? '정답입니다'
                            : currentQuizStatus === 'wrong'
                              ? '오답입니다'
                              : '답을 입력하거나 선택해 보세요'}
                        </div>

                        {currentQuizItem.type === 'mcq' && currentQuizItem.options?.length ? (
                          <div className="quizChoiceList">
                            {currentQuizItem.options.map((option, optionIndex) => {
                              const selected = currentQuizAnswer === option;
                              return (
                                <button
                                  key={`${currentQuizItem.question}-${optionIndex}`}
                                  type="button"
                                  className={`quizChoice ${selected ? 'selected' : ''} ${selected && currentQuizStatus !== 'unanswered' ? currentQuizStatus : ''}`}
                                  onClick={() => setQuizAnswer(currentQuizIndex, option)}
                                  disabled={quizSubmitted}
                                >
                                  {optionIndex + 1}. {option}
                                </button>
                              );
                            })}
                          </div>
                        ) : currentQuizItem.type === 'ox' ? (
                          <div className="quizChoiceList row">
                            {['O', 'X'].map((option) => {
                              const selected = currentQuizAnswer === option;
                              return (
                                <button
                                  key={`${currentQuizItem.question}-${option}`}
                                  type="button"
                                  className={`quizChoice ${selected ? 'selected' : ''} ${selected && currentQuizStatus !== 'unanswered' ? currentQuizStatus : ''}`}
                                  onClick={() => setQuizAnswer(currentQuizIndex, option)}
                                  disabled={quizSubmitted}
                                >
                                  {option}
                                </button>
                              );
                            })}
                          </div>
                        ) : (
                          <input
                            className={`input quizInput ${currentQuizStatus !== 'unanswered' ? `quizInput-${currentQuizStatus}` : ''}`}
                            value={currentQuizAnswer}
                            onChange={(event) => setQuizAnswer(currentQuizIndex, event.target.value)}
                            disabled={quizSubmitted}
                            placeholder="정답을 짧게 입력하세요"
                          />
                        )}

                        {quizSubmitted ? (
                          <div className="quizA">
                            정답: {currentQuizItem.type === 'mcq' && typeof currentQuizItem.correctOptionIndex === 'number' && currentQuizItem.options?.[currentQuizItem.correctOptionIndex]
                              ? currentQuizItem.options[currentQuizItem.correctOptionIndex]
                              : currentQuizItem.answer}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="dropZone">
                    <div className="dropZoneTitle">퀴즈를 준비 중입니다</div>
                    <div className="muted">PDF를 분석해 중요한 부분만 골라 간단한 한국어 퀴즈를 만듭니다.</div>
                  </div>
                )}

                {activeQuizItems.length ? (
                  <div className="quizActions">
                    <button className="button secondary" type="button" onClick={goToPreviousQuiz} disabled={quizSubmitted || currentQuizIndex === 0}>
                      이전 문제
                    </button>
                    <button
                      className="button"
                      type="button"
                      onClick={goToNextQuiz}
                      disabled={quizSubmitted || !currentQuizAnswer.trim()}
                    >
                      {currentQuizIndex === activeQuizItems.length - 1 ? '결과 보기' : '다음 문제'}
                    </button>
                    {quizSubmitted && wrongNotes.length ? (
                      <button className="button secondary" type="button" onClick={startWrongRetryExam}>
                        오답만 재시험 보기
                      </button>
                    ) : null}
                    {(quizSubmitted || retryQuizMode) ? (
                      <button className="button secondary" type="button" onClick={resetFullQuiz}>
                        전체 퀴즈 다시 풀기
                      </button>
                    ) : null}
                  </div>
                ) : null}

                {quizSubmitted ? (
                  wrongNotes.length ? (
                    <div className="wrongNoteWrap">
                      <div className="sectionTitle">오답노트</div>
                      <div className="muted">틀린 문제 {wrongNotes.length}개, 맞힌 문제 {activeQuizItems.length - wrongNotes.length}개입니다.</div>
                      <div className="wrongNoteList">
                        {wrongNotes.map((note, idx) => (
                          <div key={`${note.question}-${idx}`} className="wrongNoteItem">
                            <div className="quizQ">문제: {note.question}</div>
                            <div className="quizMeta">내 답: {note.userAnswer}</div>
                            <div className="quizMeta">정답: {note.correctAnswer}</div>
                            {note.hint ? <div className="quizHint">복습 힌트: {note.hint}</div> : null}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="quizSummary">모든 문제를 맞혔습니다. 훌륭해요.</div>
                  )
                ) : null}
              </div>
            )}
          </form>
        </div>
      </section>
    </div>
  );
}
