'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight, Download, Languages, Moon, Paperclip, Pencil, Plus, Sun, Trash2, UploadCloud, X } from 'lucide-react';
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

function sanitizePageRangeInput(value: string) {
  return value.replace(/[^\d]/g, '').slice(0, 4);
}

function normalizePageRange(startValue: string, endValue: string, pageCount: number) {
  const safePageCount = Math.max(1, Math.trunc(pageCount || 1));
  const parsedStart = Number.parseInt(startValue || '', 10);
  const parsedEnd = Number.parseInt(endValue || '', 10);
  const start = Number.isFinite(parsedStart) ? parsedStart : 1;
  const end = Number.isFinite(parsedEnd) ? parsedEnd : safePageCount;
  const boundedStart = Math.max(1, Math.min(safePageCount, start));
  const boundedEnd = Math.max(1, Math.min(safePageCount, end));
  return {
    start: Math.min(boundedStart, boundedEnd),
    end: Math.max(boundedStart, boundedEnd),
  };
}

function sanitizeProjectDescription(value?: string | null) {
  const text = (value || '').trim();
  if (!text) return '';
  if (text === '홈 화면에서 시작한 빈 프로젝트' || text === '홈 화면에서 시작한 빈프로젝트') {
    return '';
  }
  return text;
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
  const mergePdfRef = useRef<HTMLInputElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const previewEditWrapRef = useRef<HTMLDivElement>(null);
  const pdfEditAutoScrollFrameRef = useRef<number | null>(null);
  const pdfEditAutoScrollSpeedRef = useRef(0);
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
  const [projectItems, setProjectItems] = useState<ProjectItem[]>(projects);
  const [projectEditMode, setProjectEditMode] = useState(false);
  const [projectOrderSaving, setProjectOrderSaving] = useState(false);
  const [projectOrderStatus, setProjectOrderStatus] = useState('');
  const [draggingProjectId, setDraggingProjectId] = useState('');
  const [dragOverProjectInsertIndex, setDragOverProjectInsertIndex] = useState<number | null>(null);
  const [projectDeletingId, setProjectDeletingId] = useState('');
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
  const [themeMode, setThemeMode] = useState<'light' | 'dark'>('light');
  const [workspaceView, setWorkspaceView] = useState<'notes' | 'quiz'>('notes');
  const [notesRangeStart, setNotesRangeStart] = useState('1');
  const [notesRangeEnd, setNotesRangeEnd] = useState('1');
  const [quizRangeStart, setQuizRangeStart] = useState('1');
  const [quizRangeEnd, setQuizRangeEnd] = useState('1');
  const [quizAnswers, setQuizAnswers] = useState<Record<number, string>>({});
  const [quizSubmitted, setQuizSubmitted] = useState(false);
  const [wrongNotes, setWrongNotes] = useState<WrongAnswerNote[]>([]);
  const [retryQuizMode, setRetryQuizMode] = useState(false);
  const [retryQuizItems, setRetryQuizItems] = useState<QuizItem[]>([]);
  const [currentQuizIndex, setCurrentQuizIndex] = useState(0);
  const [quizAutoGenerating, setQuizAutoGenerating] = useState(false);
  const [quizAutoStatus, setQuizAutoStatus] = useState('');
  const [pdfEditMode, setPdfEditMode] = useState(false);
  const [pdfPageItems, setPdfPageItems] = useState<PageEditorItem[]>([]);
  const [pdfPageInitialOrder, setPdfPageInitialOrder] = useState<number[]>([]);
  const [pdfPageLoading, setPdfPageLoading] = useState(false);
  const [pdfPageSaving, setPdfPageSaving] = useState(false);
  const [pdfPageStatus, setPdfPageStatus] = useState('');
  const [draggingPdfPageId, setDraggingPdfPageId] = useState('');
  const [dragOverPdfInsertIndex, setDragOverPdfInsertIndex] = useState<number | null>(null);
  const [pendingMergePdf, setPendingMergePdf] = useState<File | null>(null);
  const [pdfMergeLoading, setPdfMergeLoading] = useState(false);
  const [pdfMergeStatus, setPdfMergeStatus] = useState('');

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
  const normalizedNotesRange = useMemo(
    () => normalizePageRange(notesRangeStart, notesRangeEnd, currentPdfPageCount || 1),
    [currentPdfPageCount, notesRangeEnd, notesRangeStart],
  );
  const normalizedQuizRange = useMemo(
    () => normalizePageRange(quizRangeStart, quizRangeEnd, currentPdfPageCount || 1),
    [currentPdfPageCount, quizRangeEnd, quizRangeStart],
  );
  const projectDescription = useMemo(
    () => sanitizeProjectDescription(selectedProject?.description),
    [selectedProject?.description],
  );

  const basePreviewAsset = useMemo(() => {
    if (!selectedProject) return null;

    const latestOutput = [...selectedProject.assets]
      .reverse()
      .find((asset) => asset.kind === 'output_pdf');
    if (latestOutput) return latestOutput;

    const latestPdf = [...selectedProject.assets]
      .reverse()
      .find((asset) => asset.kind === 'pdf');
    if (latestPdf) return latestPdf;

    return null;
  }, [selectedProject]);
  const basePreviewPdfUrl = useMemo(() => {
    if (!basePreviewAsset) return '';
    return `/api/assets/${basePreviewAsset.id}/raw`;
  }, [basePreviewAsset]);

  const previewPdfUrl = useMemo(() => {
    if (translationMode === 'translated' && translatedAssetId) {
      return `/api/assets/${translatedAssetId}/raw`;
    }
    return basePreviewPdfUrl;
  }, [basePreviewPdfUrl, translatedAssetId, translationMode]);
  const previewDownloadName = useMemo(() => {
    if (translationMode === 'translated' && translatedAssetId) {
      return `${selectedProject?.title || 'translated'}-translated.pdf`;
    }
    return basePreviewAsset?.originalName || `${selectedProject?.title || 'document'}.pdf`;
  }, [basePreviewAsset, selectedProject?.title, translatedAssetId, translationMode]);
  const buildPdfPagePreviewUrl = (page: number) => {
    if (!latestPdfAsset?.id) return '';
    return `/api/assets/${latestPdfAsset.id}/page-preview?page=${page}#toolbar=0&navpanes=0&scrollbar=0&zoom=page-fit`;
  };
  const pdfEditPreviewLabel = useMemo(() => {
    if (pdfPageLoading) return 'PDF 페이지를 불러오는 중...';
    if (!pdfPageItems.length) return '편집할 페이지가 없습니다.';
    return `총 ${currentPdfPageCount}페이지 · 카드를 드래그해서 순서를 바꾸고 X로 제거하세요.`;
  }, [currentPdfPageCount, pdfPageItems.length, pdfPageLoading]);
  const pdfEditBusy = pdfPageLoading || pdfPageSaving || pdfMergeLoading;
  const projectEditBusy = projectOrderSaving || Boolean(projectDeletingId);

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
    const savedTheme = window.localStorage.getItem('beautify-theme');
    if (savedTheme === 'light' || savedTheme === 'dark') {
      setThemeMode(savedTheme);
      return;
    }

    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    setThemeMode(prefersDark ? 'dark' : 'light');
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
    document.documentElement.style.colorScheme = themeMode;
    window.localStorage.setItem('beautify-theme', themeMode);
  }, [themeMode]);

  useEffect(() => {
    setProjectItems(projects);
    if (!projects.length) {
      setProjectEditMode(false);
      setProjectOrderStatus('');
      setDraggingProjectId('');
      setDragOverProjectInsertIndex(null);
    }
  }, [projects]);

  useEffect(() => {
    return () => {
      if (pdfEditAutoScrollFrameRef.current !== null) {
        cancelAnimationFrame(pdfEditAutoScrollFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setTranslationMode('original');
    setTranslatedAssetId('');
    setTranslationLoading(false);
    setTranslationStatus('');
    setPdfRemoving(false);
    setPdfRemoveStatus('');
    setPdfEditMode(false);
    setPdfPageItems([]);
    setPdfPageInitialOrder([]);
    setPdfPageLoading(false);
    setPdfPageSaving(false);
    setPdfPageStatus('');
    setDraggingPdfPageId('');
    setDragOverPdfInsertIndex(null);
    setPendingMergePdf(null);
    setPdfMergeLoading(false);
    setPdfMergeStatus('');
    pdfEditAutoScrollSpeedRef.current = 0;
    if (pdfEditAutoScrollFrameRef.current !== null) {
      cancelAnimationFrame(pdfEditAutoScrollFrameRef.current);
      pdfEditAutoScrollFrameRef.current = null;
    }
  }, [selectedProject?.id]);

  useEffect(() => {
    if (pdfEditMode) return;
    pdfEditAutoScrollSpeedRef.current = 0;
    if (pdfEditAutoScrollFrameRef.current !== null) {
      cancelAnimationFrame(pdfEditAutoScrollFrameRef.current);
      pdfEditAutoScrollFrameRef.current = null;
    }
    setPendingMergePdf(null);
    setPdfMergeStatus('');
  }, [pdfEditMode]);

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
  }, [selectedProject?.id, selectedProject?.lastRun?.questionsJson]);

  useEffect(() => {
    if (!latestPdfAsset?.id || !currentPdfPageCount) {
      setNotesRangeStart('1');
      setNotesRangeEnd('1');
      setQuizRangeStart('1');
      setQuizRangeEnd('1');
      return;
    }

    const fullEnd = String(currentPdfPageCount);
    setNotesRangeStart('1');
    setNotesRangeEnd(fullEnd);
    setQuizRangeStart('1');
    setQuizRangeEnd(fullEnd);
  }, [currentPdfPageCount, latestPdfAsset?.id]);

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
      setPdfEditMode(false);
      setPdfPageSaving(false);
      setPdfPageStatus('');
      setPdfPageLoading(false);
      setDraggingPdfPageId('');
      setDragOverPdfInsertIndex(null);
      return () => {
        active = false;
      };
    }

    async function loadPdfPages() {
      setPdfPageLoading(true);
      setPdfPageStatus('');
      setDraggingPdfPageId('');
      setDragOverPdfInsertIndex(null);
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

  function applyNotesRangeNormalization() {
    const normalized = normalizePageRange(notesRangeStart, notesRangeEnd, currentPdfPageCount || 1);
    setNotesRangeStart(String(normalized.start));
    setNotesRangeEnd(String(normalized.end));
  }

  function applyQuizRangeNormalization() {
    const normalized = normalizePageRange(quizRangeStart, quizRangeEnd, currentPdfPageCount || 1);
    setQuizRangeStart(String(normalized.start));
    setQuizRangeEnd(String(normalized.end));
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

  function deletePdfPageById(itemId: string) {
    const index = pdfPageItems.findIndex((item) => item.id === itemId);
    if (index < 0) return;
    deletePdfPage(index);
  }

  function movePdfPageById(sourceId: string, targetId: string) {
    if (!sourceId || !targetId || sourceId === targetId) return;

    setPdfPageItems((prev) => {
      const sourceIndex = prev.findIndex((item) => item.id === sourceId);
      const targetIndex = prev.findIndex((item) => item.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return prev;

      const next = [...prev];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
    setPdfPageStatus('페이지 순서를 바꿨습니다. 변경 적용을 누르면 새 PDF에 반영됩니다.');
  }

  function movePdfPageToIndex(sourceId: string, targetIndex: number) {
    if (!sourceId) return;

    setPdfPageItems((prev) => {
      const sourceIndex = prev.findIndex((item) => item.id === sourceId);
      if (sourceIndex < 0) return prev;

      const boundedTargetIndex = Math.max(0, Math.min(targetIndex, prev.length));
      const next = [...prev];
      const [moved] = next.splice(sourceIndex, 1);
      const adjustedTargetIndex = sourceIndex < boundedTargetIndex ? boundedTargetIndex - 1 : boundedTargetIndex;

      if (sourceIndex === adjustedTargetIndex) return prev;

      next.splice(adjustedTargetIndex, 0, moved);
      return next;
    });
    setPdfPageStatus('페이지 순서를 바꿨습니다. 변경 적용을 누르면 새 PDF에 반영됩니다.');
  }

  function resetPdfDragState() {
    setDraggingPdfPageId('');
    setDragOverPdfInsertIndex(null);
    stopPdfEditAutoScroll();
  }

  function stopPdfEditAutoScroll() {
    pdfEditAutoScrollSpeedRef.current = 0;
    if (pdfEditAutoScrollFrameRef.current !== null) {
      cancelAnimationFrame(pdfEditAutoScrollFrameRef.current);
      pdfEditAutoScrollFrameRef.current = null;
    }
  }

  function runPdfEditAutoScroll() {
    const container = previewEditWrapRef.current;
    const speed = pdfEditAutoScrollSpeedRef.current;

    if (!container || Math.abs(speed) < 0.5) {
      stopPdfEditAutoScroll();
      return;
    }

    const previousTop = container.scrollTop;
    container.scrollTop += speed;

    if (container.scrollTop === previousTop) {
      stopPdfEditAutoScroll();
      return;
    }

    pdfEditAutoScrollFrameRef.current = window.requestAnimationFrame(runPdfEditAutoScroll);
  }

  function updatePdfEditAutoScroll(clientY: number) {
    if (!draggingPdfPageId) return;

    const container = previewEditWrapRef.current;
    if (!container) return;

    const bounds = container.getBoundingClientRect();
    const threshold = Math.max(72, Math.min(128, bounds.height * 0.2));
    let nextSpeed = 0;

    if (clientY > bounds.bottom - threshold) {
      const ratio = (clientY - (bounds.bottom - threshold)) / threshold;
      nextSpeed = Math.min(28, 6 + ratio * 22);
    } else if (clientY < bounds.top + threshold) {
      const ratio = ((bounds.top + threshold) - clientY) / threshold;
      nextSpeed = -Math.min(28, 6 + ratio * 22);
    }

    if (Math.abs(nextSpeed) < 0.5) {
      stopPdfEditAutoScroll();
      return;
    }

    pdfEditAutoScrollSpeedRef.current = nextSpeed;
    if (pdfEditAutoScrollFrameRef.current === null) {
      pdfEditAutoScrollFrameRef.current = window.requestAnimationFrame(runPdfEditAutoScroll);
    }
  }

  function shouldIgnorePdfCardDrag(target: EventTarget | null) {
    return target instanceof HTMLElement && Boolean(target.closest('button'));
  }

  function shouldIgnoreProjectCardDrag(target: EventTarget | null) {
    return target instanceof HTMLElement && Boolean(target.closest('button'));
  }

  function resetProjectDragState() {
    setDraggingProjectId('');
    setDragOverProjectInsertIndex(null);
  }

  function moveProjectItems(sourceId: string, targetIndex: number) {
    const sourceIndex = projectItems.findIndex((project) => project.id === sourceId);
    if (sourceIndex < 0) return null;

    const boundedTargetIndex = Math.max(0, Math.min(targetIndex, projectItems.length));
    const next = [...projectItems];
    const [moved] = next.splice(sourceIndex, 1);
    const adjustedTargetIndex = sourceIndex < boundedTargetIndex ? boundedTargetIndex - 1 : boundedTargetIndex;

    if (sourceIndex === adjustedTargetIndex) return null;

    next.splice(adjustedTargetIndex, 0, moved);
    return next;
  }

  async function persistProjectOrder(nextItems: ProjectItem[], previousItems: ProjectItem[]) {
    if (projectOrderSaving) return;

    setProjectItems(nextItems);
    setProjectOrderSaving(true);
    setProjectOrderStatus('프로젝트 순서를 저장하는 중...');

    try {
      const response = await fetch('/api/projects', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectIds: nextItems.map((project) => project.id),
        }),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setProjectItems(previousItems);
        setProjectOrderStatus(typeof payload?.error === 'string' ? payload.error : '프로젝트 순서를 저장하지 못했습니다.');
        return;
      }

      setProjectOrderStatus('프로젝트 순서를 저장했습니다.');
      router.refresh();
    } catch {
      setProjectItems(previousItems);
      setProjectOrderStatus('프로젝트 순서 저장 중 네트워크 오류가 발생했습니다.');
    } finally {
      setProjectOrderSaving(false);
    }
  }

  async function deleteProject(projectId: string) {
    if (projectDeletingId) return;
    const confirmed = window.confirm('프로젝트를 삭제하시겠습니까?');
    if (!confirmed) return;

    const previousItems = projectItems;
    const nextItems = projectItems.filter((project) => project.id !== projectId);

    setProjectDeletingId(projectId);
    setProjectItems(nextItems);
    setProjectOrderStatus('프로젝트를 삭제하는 중...');

    try {
      const response = await fetch(`/api/projects/${projectId}`, {
        method: 'DELETE',
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setProjectItems(previousItems);
        setProjectOrderStatus(typeof payload?.error === 'string' ? payload.error : '프로젝트를 삭제하지 못했습니다.');
        return;
      }

      if (!nextItems.length) {
        setProjectEditMode(false);
      }

      setProjectOrderStatus('프로젝트를 삭제했습니다.');
      resetProjectDragState();

      if (selectedProject?.id === projectId) {
        const nextSelectedId = nextItems[0]?.id;
        router.push(nextSelectedId ? `/?projectId=${nextSelectedId}` : '/');
      }

      router.refresh();
    } catch {
      setProjectItems(previousItems);
      setProjectOrderStatus('프로젝트 삭제 중 네트워크 오류가 발생했습니다.');
    } finally {
      setProjectDeletingId('');
    }
  }

  function handleMergePdfSelect(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    if (!isPdf) {
      setPendingMergePdf(null);
      setPdfMergeStatus('PDF 파일만 추가할 수 있습니다.');
      return;
    }

    setPendingMergePdf(file);
    setPdfMergeStatus(`추가 PDF "${file.name}"를 현재 PDF 앞에 둘지, 뒤에 둘지 선택해 주세요.`);
  }

  function cancelPendingMergePdf() {
    setPendingMergePdf(null);
    setPdfMergeStatus('');
  }

  async function mergePdfIntoCurrent(position: 'before' | 'after') {
    if (!selectedProject?.id || !pendingMergePdf || pdfMergeLoading) return;

    setPdfMergeLoading(true);
    setPdfMergeStatus(position === 'before' ? '추가 PDF를 현재 PDF 앞에 합치는 중...' : '추가 PDF를 현재 PDF 뒤에 합치는 중...');

    try {
      const formData = new FormData();
      formData.set('pdf', pendingMergePdf);
      formData.set('position', position);

      const response = await fetch(`/api/projects/${selectedProject.id}/pdf-merge`, {
        method: 'POST',
        body: formData,
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setPdfMergeStatus(typeof payload?.error === 'string' ? payload.error : '추가 PDF를 합치지 못했습니다.');
        return;
      }

      setPendingMergePdf(null);
      setPdfMergeStatus('추가 PDF를 반영했습니다. 새 PDF 기준으로 편집 페이지를 다시 불러옵니다.');
      router.refresh();
    } catch {
      setPdfMergeStatus('추가 PDF를 합치는 중 네트워크 오류가 발생했습니다.');
    } finally {
      setPdfMergeLoading(false);
    }
  }

  function resetPdfPageEdits() {
    setPdfPageItems(pdfPageInitialOrder.map((page) => createPageEditorItem(page)));
    resetPdfDragState();
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
      setQuizAutoStatus('');
      setPdfEditMode(false);
      resetPdfDragState();
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
    if (!hasPdfAsset) {
      setQuizAutoStatus('퀴즈를 만들려면 먼저 PDF를 업로드해 주세요.');
      return;
    }

    const pageCount = currentPdfPageCount || 1;
    const normalizedRange = normalizePageRange(quizRangeStart, quizRangeEnd, pageCount);

    setQuizAutoGenerating(true);
    setQuizAutoStatus(`PDF ${normalizedRange.start}~${normalizedRange.end}페이지를 분석해 퀴즈를 만드는 중...`);
    try {
      const formData = new FormData();
      formData.set('projectId', selectedProject.id);
      formData.set('redirectTo', `/?projectId=${selectedProject.id}`);
      formData.set('mode', 'quiz');
      formData.set('rangeStart', String(normalizedRange.start));
      formData.set('rangeEnd', String(normalizedRange.end));
      formData.set('noteText', '');
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

      setQuizAutoStatus(`PDF ${normalizedRange.start}~${normalizedRange.end}페이지 기준 퀴즈가 준비되었습니다.`);
      router.refresh();
    } catch {
      setQuizAutoStatus('퀴즈 자동 생성 중 네트워크 오류가 발생했습니다.');
    } finally {
      setQuizAutoGenerating(false);
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
              <input type="hidden" name="description" value="" />
              <button className="iconButton" type="submit" aria-label="새 프로젝트 만들기">
                <Plus size={16} />
              </button>
            </form>
            <button
              className={`iconButton ${projectEditMode ? 'previewModeButtonActive' : ''}`}
              type="button"
              aria-label={projectEditMode ? '프로젝트 편집 닫기' : '프로젝트 편집 열기'}
              onClick={() => {
                setProjectEditMode((prev) => !prev);
                resetProjectDragState();
                setProjectOrderStatus('');
              }}
              disabled={projectEditBusy}
            >
              <Pencil size={16} />
            </button>
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
        {projectEditMode ? <div className="muted">프로젝트를 드래그해서 순서를 바꾸고, 오른쪽 위 X로 삭제하세요.</div> : null}
        {projectOrderStatus ? <div className="muted">{projectOrderStatus}</div> : null}
        <div className={`sidebarList ${projectEditMode ? 'sidebarProjectEditList' : ''}`}>
          {projectEditMode ? (
            <>
              {projectItems.map((project, index) => (
                <div
                  key={project.id}
                  className={`sidebarProjectCell ${dragOverProjectInsertIndex === index ? 'dropTarget' : ''}`}
                  onDragOver={(event) => {
                    event.preventDefault();
                    if (draggingProjectId) {
                      setDragOverProjectInsertIndex(index);
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const sourceId = event.dataTransfer.getData('text/plain') || draggingProjectId;
                    const nextItems = moveProjectItems(sourceId, index);
                    resetProjectDragState();
                    if (!nextItems) return;
                    void persistProjectOrder(nextItems, projectItems);
                  }}
                >
                  {dragOverProjectInsertIndex === index ? <div className="sidebarProjectInsertMarker" aria-hidden="true" /> : null}
                  <div
                    className={`sidebarItem sidebarProjectItem ${selectedProject?.id === project.id ? 'active' : ''} ${draggingProjectId === project.id ? 'dragging' : ''}`}
                    draggable={!projectEditBusy}
                    onDragStart={(event) => {
                      if (shouldIgnoreProjectCardDrag(event.target)) {
                        event.preventDefault();
                        return;
                      }
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('text/plain', project.id);
                      setDraggingProjectId(project.id);
                      setDragOverProjectInsertIndex(index);
                    }}
                    onDragEnd={resetProjectDragState}
                  >
                    <button
                      type="button"
                      className="pageEditorRemove sidebarProjectRemove"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        void deleteProject(project.id);
                      }}
                      disabled={projectEditBusy}
                      draggable={false}
                      aria-label={`${project.title} 삭제`}
                      title="프로젝트 삭제"
                    >
                      <X size={14} />
                    </button>
                    <div className="sidebarItemTitle">{project.title}</div>
                    <div className="sidebarItemMeta">
                      <span>{project.subject || '과목 자동 분석'}</span>
                      <span>자료 {project.assetCount}</span>
                    </div>
                  </div>
                </div>
              ))}
              <div
                className={`sidebarProjectTailDrop ${dragOverProjectInsertIndex === projectItems.length ? 'dropTarget' : ''}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  if (draggingProjectId) {
                    setDragOverProjectInsertIndex(projectItems.length);
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const sourceId = event.dataTransfer.getData('text/plain') || draggingProjectId;
                  const nextItems = moveProjectItems(sourceId, projectItems.length);
                  resetProjectDragState();
                  if (!nextItems) return;
                  void persistProjectOrder(nextItems, projectItems);
                }}
              >
                {dragOverProjectInsertIndex === projectItems.length ? <div className="sidebarProjectInsertMarker" aria-hidden="true" /> : null}
              </div>
            </>
          ) : (
            <>
              {projectItems.map((project) => (
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
            </>
          )}
          {!projectItems.length ? <div className="emptyHint">아직 프로젝트가 없습니다.</div> : null}
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
            <div className="muted">{projectDescription || 'PDF를 드래그해서 넣고, 입력창에 요청을 적은 뒤 생성을 누르면 됩니다.'}</div>
            {pdfName ? <div className="fileBadge">최근 드롭 PDF · {pdfName}</div> : null}
            {audioName ? <div className="fileBadge">최근 드롭 오디오 · {audioName}</div> : null}
          </div>
          <div className="topBarActions">
            <button
              className={`iconButton themeToggleButton ${themeMode === 'dark' ? 'themeToggleButtonActive' : ''}`}
              type="button"
              aria-label={themeMode === 'dark' ? '기본 모드로 전환' : '다크 모드로 전환'}
              title={themeMode === 'dark' ? '기본모드' : '다크모드'}
              onClick={() => setThemeMode((prev) => (prev === 'dark' ? 'light' : 'dark'))}
            >
              {themeMode === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <AuthControls
              loadingBalance={loadingBalance}
              creditBalance={creditBalance}
              billingStatus={billingStatus}
              autoRechargeEnabled={autoRechargeEnabled}
              onQuickCharge={() => void quickCharge()}
              onToggleAutoRecharge={(checked) => {
                void toggleAutoRecharge(checked);
              }}
            />
          </div>
        </div>

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
                  <a
                    className="button secondary"
                    href={previewPdfUrl}
                    download={previewDownloadName}
                    title="현재 보고 있는 PDF 다운로드"
                  >
                    <Download size={16} />
                    PDF 다운로드
                  </a>
                ) : null}
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
                    className={`button secondary ${pdfEditMode ? 'previewModeButtonActive' : ''}`}
                    type="button"
                    onClick={() => setPdfEditMode((prev) => !prev)}
                    disabled={pdfPageLoading || pdfPageSaving}
                    title={pdfEditMode ? '편집 모드 닫기' : 'PDF 편집 모드 열기'}
                  >
                    <Pencil size={16} />
                    {pdfEditMode ? '편집 닫기' : '편집'}
                  </button>
                ) : null}
                {latestPdfAsset ? (
                  <button
                    className="button danger"
                    type="button"
                    onClick={() => {
                      setPdfEditMode(false);
                      void removeLatestPdf();
                    }}
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
              pdfEditMode ? (
                <div
                  className="previewEditWrap"
                  ref={previewEditWrapRef}
                  onDragOver={(event) => {
                    event.preventDefault();
                    updatePdfEditAutoScroll(event.clientY);
                  }}
                  onDragLeave={stopPdfEditAutoScroll}
                  onDrop={stopPdfEditAutoScroll}
                >
                  <div className="previewEditToolbar">
                    <div className="muted">{pdfEditPreviewLabel}</div>
                    <div className="row">
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => mergePdfRef.current?.click()}
                        disabled={pdfEditBusy}
                      >
                        <Plus size={16} />
                        PDF 추가
                      </button>
                      <button
                        type="button"
                        className="button secondary"
                        onClick={resetPdfPageEdits}
                        disabled={pdfEditBusy || !pdfPageItems.length || !pdfPageDirty}
                      >
                        초기화
                      </button>
                      <button
                        type="button"
                        className="button"
                        onClick={() => void applyPdfPageEdits()}
                        disabled={pdfEditBusy || !pdfPageItems.length || !pdfPageDirty}
                      >
                        {pdfPageSaving ? '적용 중...' : '변경 적용'}
                      </button>
                    </div>
                  </div>
                  <input
                    ref={mergePdfRef}
                    className="hiddenInput"
                    type="file"
                    accept="application/pdf,.pdf"
                    onChange={handleMergePdfSelect}
                  />
                  {pendingMergePdf ? (
                    <div className="previewEditPrompt">
                      <div className="previewEditPromptTitle">추가 PDF 위치 선택</div>
                      <div className="previewEditPromptBody">
                        <strong>{pendingMergePdf.name}</strong>을(를) 현재 PDF의 앞에 넣을지, 뒤에 넣을지 선택해 주세요.
                        필기, 퀴즈, 번역 결과는 새 PDF 기준으로 다시 정리됩니다.
                      </div>
                      <div className="previewEditPromptActions">
                        <button
                          type="button"
                          className="button secondary"
                          onClick={() => void mergePdfIntoCurrent('before')}
                          disabled={pdfMergeLoading}
                        >
                          현재 PDF 앞에 추가
                        </button>
                        <button
                          type="button"
                          className="button"
                          onClick={() => void mergePdfIntoCurrent('after')}
                          disabled={pdfMergeLoading}
                        >
                          현재 PDF 뒤에 추가
                        </button>
                        <button
                          type="button"
                          className="button ghost"
                          onClick={cancelPendingMergePdf}
                          disabled={pdfMergeLoading}
                        >
                          취소
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {pdfPageStatus ? <div className="muted">{pdfPageStatus}</div> : null}
                  {pdfMergeStatus ? <div className="muted">{pdfMergeStatus}</div> : null}
                  {pdfPageLoading ? (
                    <div className="pageEditorEmpty previewEditEmpty">PDF 페이지를 불러오는 중...</div>
                  ) : pdfPageItems.length ? (
                    <div className="previewEditGrid">
                      {pdfPageItems.map((item, index) => (
                        <div
                          key={item.id}
                          className={`previewEditCell ${dragOverPdfInsertIndex === index ? 'dropTarget' : ''}`}
                          onDragOver={(event) => {
                            event.preventDefault();
                            updatePdfEditAutoScroll(event.clientY);
                            if (draggingPdfPageId) {
                              setDragOverPdfInsertIndex(index);
                            }
                          }}
                          onDrop={(event) => {
                            event.preventDefault();
                            const sourceId = event.dataTransfer.getData('text/plain') || draggingPdfPageId;
                            movePdfPageToIndex(sourceId, index);
                            resetPdfDragState();
                          }}
                        >
                          {dragOverPdfInsertIndex === index ? <div className="previewEditInsertMarker" aria-hidden="true" /> : null}
                          <div
                            className={`previewEditCard ${draggingPdfPageId === item.id ? 'dragging' : ''}`}
                            draggable={!pdfEditBusy}
                            onDragStart={(event) => {
                              if (shouldIgnorePdfCardDrag(event.target)) {
                                event.preventDefault();
                                return;
                              }
                              event.dataTransfer.effectAllowed = 'move';
                              event.dataTransfer.setData('text/plain', item.id);
                              setDraggingPdfPageId(item.id);
                              setDragOverPdfInsertIndex(index);
                            }}
                            onDragEnd={resetPdfDragState}
                          >
                            <div className="previewEditCardViewport">
                              <iframe
                                className="previewEditCardFrame"
                                src={buildPdfPagePreviewUrl(item.sourcePage)}
                                title={`PDF ${item.sourcePage}페이지 미리보기`}
                              />
                            </div>
                            <button
                              type="button"
                              className="pageEditorRemove previewEditCardRemove"
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={(event) => {
                                event.stopPropagation();
                                deletePdfPageById(item.id);
                              }}
                              disabled={pdfEditBusy || pdfPageItems.length <= 1}
                              draggable={false}
                              aria-label={`${index + 1}페이지 제거`}
                              title="페이지 제거"
                            >
                              <X size={14} />
                            </button>
                            <div className="previewEditCardOrder">{index + 1}</div>
                            <div className="previewEditCardMeta">
                              <div className="previewEditCardTitle">현재 {index + 1}페이지</div>
                              <div className="previewEditCardSource">원본 {item.sourcePage}페이지</div>
                            </div>
                          </div>
                        </div>
                      ))}
                      <div
                        className={`previewEditTailDrop ${dragOverPdfInsertIndex === pdfPageItems.length ? 'dropTarget' : ''}`}
                        onDragOver={(event) => {
                          event.preventDefault();
                          updatePdfEditAutoScroll(event.clientY);
                          if (draggingPdfPageId) {
                            setDragOverPdfInsertIndex(pdfPageItems.length);
                          }
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          const sourceId = event.dataTransfer.getData('text/plain') || draggingPdfPageId;
                          movePdfPageToIndex(sourceId, pdfPageItems.length);
                          resetPdfDragState();
                        }}
                      >
                        {dragOverPdfInsertIndex === pdfPageItems.length ? <div className="previewEditInsertMarker" aria-hidden="true" /> : null}
                      </div>
                    </div>
                  ) : (
                    <div className="pageEditorEmpty previewEditEmpty">편집할 PDF 페이지를 찾지 못했습니다.</div>
                  )}
                </div>
              ) : (
                <div className="previewFrameWrap">
                  <iframe className="previewFrame" src={previewPdfUrl} title="PDF 미리보기" />
                </div>
              )
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
            <input type="hidden" name="mode" value="notes" />
            <input type="hidden" name="rangeStart" value={String(normalizedNotesRange.start)} />
            <input type="hidden" name="rangeEnd" value={String(normalizedNotesRange.end)} />
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
                <div className="generationRangeCard">
                  <div className="generationRangeHeader">
                    <div>
                      <div className="sectionTitle">필기 생성 범위</div>
                      <div className="muted">
                        현재 PDF의 {normalizedNotesRange.start}페이지부터 {normalizedNotesRange.end}페이지까지 분석해서 PDF 위에 필기를 넣습니다.
                      </div>
                    </div>
                    <div className="generationRangeBadge">총 {currentPdfPageCount || 0}페이지</div>
                  </div>
                  <div className="generationRangeInputs">
                    <label className="generationRangeField">
                      <span>시작 페이지</span>
                      <input
                        className="input generationRangeInput"
                        type="number"
                        min={1}
                        max={currentPdfPageCount || 1}
                        inputMode="numeric"
                        value={notesRangeStart}
                        onChange={(event) => setNotesRangeStart(sanitizePageRangeInput(event.target.value))}
                        onBlur={applyNotesRangeNormalization}
                        disabled={!hasPdfAsset || isGenerating}
                      />
                    </label>
                    <label className="generationRangeField">
                      <span>끝 페이지</span>
                      <input
                        className="input generationRangeInput"
                        type="number"
                        min={1}
                        max={currentPdfPageCount || 1}
                        inputMode="numeric"
                        value={notesRangeEnd}
                        onChange={(event) => setNotesRangeEnd(sanitizePageRangeInput(event.target.value))}
                        onBlur={applyNotesRangeNormalization}
                        disabled={!hasPdfAsset || isGenerating}
                      />
                    </label>
                    <button
                      type="button"
                      className="button secondary generationRangeReset"
                      onClick={() => {
                        const fullEnd = String(currentPdfPageCount || 1);
                        setNotesRangeStart('1');
                        setNotesRangeEnd(fullEnd);
                      }}
                      disabled={!hasPdfAsset || isGenerating}
                    >
                      전체 범위
                    </button>
                  </div>
                </div>
                <div className="composerRow">
                  <textarea
                    className="textarea composerInput"
                    name="noteText"
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    placeholder="예: 교수님이 역전파 유도 과정과 Transformer attention 계산을 중요하다고 했어. 해당 페이지들에 수식 카드와 흐름도를 넣어서 새 필기 PDF로 만들어줘"
                    disabled={isGenerating}
                  />
                </div>
                <div className="muted">생성을 누르면 현재 PDF 페이지 위에 필기, 수식, 그래프, 년표 같은 보조 자료를 직접 넣은 새 필기 PDF를 만듭니다.</div>

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
                  <button className="button generateButton" type="submit" disabled={isGenerating}>
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

              </>
            ) : (
              <div className="quizTabPanel">
                <div className="quizAutoInline">
                  {retryQuizMode ? <div className="badge">오답 재시험</div> : <div className="muted">범위를 정한 뒤 PDF를 실제로 분석해서 한국어 퀴즈를 만듭니다.</div>}
                  {quizAutoStatus ? <div className="muted">상태: {quizAutoStatus}</div> : null}
                </div>
                <div className="generationRangeCard quizRangeCard">
                  <div className="generationRangeHeader">
                    <div>
                      <div className="sectionTitle">퀴즈 출제 범위</div>
                      <div className="muted">
                        현재 PDF의 {normalizedQuizRange.start}페이지부터 {normalizedQuizRange.end}페이지까지 분석해서 중요한 부분만 문제로 냅니다.
                      </div>
                    </div>
                    <div className="generationRangeBadge">총 {currentPdfPageCount || 0}페이지</div>
                  </div>
                  <div className="generationRangeInputs">
                    <label className="generationRangeField">
                      <span>시작 페이지</span>
                      <input
                        className="input generationRangeInput"
                        type="number"
                        min={1}
                        max={currentPdfPageCount || 1}
                        inputMode="numeric"
                        value={quizRangeStart}
                        onChange={(event) => setQuizRangeStart(sanitizePageRangeInput(event.target.value))}
                        onBlur={applyQuizRangeNormalization}
                        disabled={!hasPdfAsset || quizAutoGenerating}
                      />
                    </label>
                    <label className="generationRangeField">
                      <span>끝 페이지</span>
                      <input
                        className="input generationRangeInput"
                        type="number"
                        min={1}
                        max={currentPdfPageCount || 1}
                        inputMode="numeric"
                        value={quizRangeEnd}
                        onChange={(event) => setQuizRangeEnd(sanitizePageRangeInput(event.target.value))}
                        onBlur={applyQuizRangeNormalization}
                        disabled={!hasPdfAsset || quizAutoGenerating}
                      />
                    </label>
                    <button
                      type="button"
                      className="button secondary generationRangeReset"
                      onClick={() => {
                        const fullEnd = String(currentPdfPageCount || 1);
                        setQuizRangeStart('1');
                        setQuizRangeEnd(fullEnd);
                      }}
                      disabled={!hasPdfAsset || quizAutoGenerating}
                    >
                      전체 범위
                    </button>
                  </div>
                  <button
                    type="button"
                    className="button generateButton"
                    disabled={quizAutoGenerating || !selectedProject?.id || !hasPdfAsset}
                    onClick={() => {
                      void autoGenerateQuiz();
                    }}
                  >
                    {quizAutoGenerating ? '퀴즈 생성 중...' : activeQuizItems.length ? '퀴즈 다시 생성' : '퀴즈 생성'}
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
