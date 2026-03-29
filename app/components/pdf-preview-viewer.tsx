'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  Download,
  ExternalLink,
  Hand,
  Info,
  Maximize,
  Minus,
  Printer,
  RotateCcw,
  RotateCw,
  ScanLine,
  ScrollText,
  Type,
  WrapText,
  X,
  ZoomIn,
} from 'lucide-react';

type PdfPreviewViewerProps = {
  src: string;
  fileName: string;
};

type PdfDocumentProperties = {
  title?: string;
  author?: string;
  subject?: string;
  creator?: string;
  producer?: string;
  keywords?: string;
  creationDate?: string;
  modificationDate?: string;
};

type ScrollModeKey = 'vertical' | 'horizontal' | 'wrapped';
type SpreadModeKey = 'none' | 'odd' | 'even';
type ToolModeKey = 'text' | 'hand';

type ViewerRuntime = {
  pdfjsLib: typeof import('pdfjs-dist/build/pdf.mjs');
  pdfjsViewer: typeof import('pdfjs-dist/web/pdf_viewer.mjs');
  pdfViewer: import('pdfjs-dist/types/web/pdf_viewer').PDFViewer;
  linkService: import('pdfjs-dist/types/web/pdf_link_service').PDFLinkService;
  eventBus: import('pdfjs-dist/types/web/event_utils').EventBus;
  pdfDocument: import('pdfjs-dist/types/src/display/api').PDFDocumentProxy;
  loadingTask: import('pdfjs-dist/types/src/display/api').PDFDocumentLoadingTask;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function formatPdfDate(value?: string) {
  if (!value) return '';
  const pdfMatch = value.match(/^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/);
  if (pdfMatch) {
    const [, year, month = '01', day = '01', hour = '00', minute = '00', second = '00'] = pdfMatch;
    const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}`);
    if (!Number.isNaN(date.getTime())) {
      return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
    }
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(parsed);
}

function parseMetadata(
  metadata: Awaited<ReturnType<import('pdfjs-dist/types/src/display/api').PDFDocumentProxy['getMetadata']>> | null,
) {
  if (!metadata) return {};
  const info = (metadata.info || {}) as Record<string, unknown>;

  return {
    title: typeof info.Title === 'string' ? info.Title : '',
    author: typeof info.Author === 'string' ? info.Author : '',
    subject: typeof info.Subject === 'string' ? info.Subject : '',
    creator: typeof info.Creator === 'string' ? info.Creator : '',
    producer: typeof info.Producer === 'string' ? info.Producer : '',
    keywords: typeof info.Keywords === 'string' ? info.Keywords : '',
    creationDate: typeof info.CreationDate === 'string' ? formatPdfDate(info.CreationDate) : '',
    modificationDate: typeof info.ModDate === 'string' ? formatPdfDate(info.ModDate) : '',
  } satisfies PdfDocumentProperties;
}

export function PdfPreviewViewer({ src, fileName }: PdfPreviewViewerProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<ViewerRuntime | null>(null);
  const handStateRef = useRef({
    dragging: false,
    pointerId: -1,
    startX: 0,
    startY: 0,
    scrollLeft: 0,
    scrollTop: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [scalePercent, setScalePercent] = useState(100);
  const [rotation, setRotation] = useState(0);
  const [scrollMode, setScrollMode] = useState<ScrollModeKey>('vertical');
  const [spreadMode, setSpreadMode] = useState<SpreadModeKey>('none');
  const [toolMode, setToolMode] = useState<ToolModeKey>('text');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [docProperties, setDocProperties] = useState<PdfDocumentProperties>({});

  const scrollModeLabel = useMemo(() => {
    if (scrollMode === 'horizontal') return '가로 스크롤';
    if (scrollMode === 'wrapped') return '랩 스크롤';
    return '세로 스크롤';
  }, [scrollMode]);

  const spreadModeLabel = useMemo(() => {
    if (spreadMode === 'odd') return '홀수 스프레드';
    if (spreadMode === 'even') return '짝수 스프레드';
    return '단일 페이지';
  }, [spreadMode]);

  function cleanupRuntime() {
    const runtime = runtimeRef.current;
    runtimeRef.current = null;
    if (!runtime) return;

    try {
      runtime.loadingTask.destroy();
    } catch {}
    try {
      runtime.pdfViewer.cleanup();
    } catch {}
    try {
      runtime.pdfDocument.destroy();
    } catch {}

    if (viewerRef.current) {
      viewerRef.current.replaceChildren();
    }
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setMenuOpen(false);
    setPropertiesOpen(false);
    setPageCount(0);
    setCurrentPage(1);
    setPageInput('1');
    setScalePercent(100);
    setRotation(0);
    setScrollMode('vertical');
    setSpreadMode('none');
    setToolMode('text');
    setDocProperties({});
    cleanupRuntime();

    async function boot() {
      try {
        const pdfjsLib = await import('pdfjs-dist/build/pdf.mjs');
        (globalThis as { pdfjsLib?: typeof pdfjsLib }).pdfjsLib = pdfjsLib;
        const pdfjsViewer = await import('pdfjs-dist/web/pdf_viewer.mjs');

        if (cancelled || !containerRef.current || !viewerRef.current) return;

        pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdfjs/build/pdf.worker.mjs';

        const eventBus = new pdfjsViewer.EventBus();
        const linkService = new pdfjsViewer.PDFLinkService({ eventBus });
        const pdfViewer = new pdfjsViewer.PDFViewer({
          container: containerRef.current,
          viewer: viewerRef.current,
          eventBus,
          linkService,
          textLayerMode: 1,
          enablePermissions: true,
          removePageBorders: false,
          enableAutoLinking: true,
          imageResourcesPath: '/pdfjs/web/images/',
        });

        linkService.setViewer(pdfViewer);

        const onPagesInit = () => {
          pdfViewer.currentScaleValue = 'page-width';
          setScalePercent(Math.round((Number(pdfViewer.currentScale) || 1) * 100));
          setLoading(false);
        };
        const onPageChanging = (event: { pageNumber?: number }) => {
          const next = clamp(Number(event.pageNumber || 1), 1, Math.max(1, pageCount || runtimeRef.current?.pdfDocument.numPages || 1));
          setCurrentPage(next);
          setPageInput(String(next));
        };
        const onPagesLoaded = (event: { pagesCount?: number }) => {
          const count = Number(event.pagesCount || 0) || pdfViewer.pagesCount || 0;
          setPageCount(count);
          setCurrentPage((prev) => clamp(prev, 1, Math.max(1, count)));
        };
        const onScaleChanging = (event: { scale?: number }) => {
          const nextScale = Number(event.scale || pdfViewer.currentScale || 1);
          setScalePercent(Math.round(nextScale * 100));
        };

        eventBus.on('pagesinit', onPagesInit);
        eventBus.on('pagechanging', onPageChanging);
        eventBus.on('pagesloaded', onPagesLoaded);
        eventBus.on('scalechanging', onScaleChanging);

        const loadingTask = pdfjsLib.getDocument({
          url: src,
          cMapUrl: '/pdfjs/cmaps/',
          cMapPacked: true,
          standardFontDataUrl: '/pdfjs/standard_fonts/',
          wasmUrl: '/pdfjs/wasm/',
        });
        const pdfDocument = await loadingTask.promise;
        if (cancelled) {
          await loadingTask.destroy();
          return;
        }

        linkService.setDocument(pdfDocument, null);
        pdfViewer.setDocument(pdfDocument);
        setPageCount(pdfDocument.numPages);
        setPageInput('1');
        setDocProperties(parseMetadata(await pdfDocument.getMetadata().catch(() => null)));

        runtimeRef.current = {
          pdfjsLib,
          pdfjsViewer,
          pdfViewer,
          linkService,
          eventBus,
          pdfDocument,
          loadingTask,
        };
      } catch (viewerError) {
        console.error('pdf preview viewer failed', viewerError);
        if (!cancelled) {
          setError('PDF 뷰어를 불러오지 못했습니다.');
          setLoading(false);
        }
      }
    }

    void boot();

    return () => {
      cancelled = true;
      cleanupRuntime();
    };
  }, [src]);

  useEffect(() => {
    function handleOutsideClick(event: MouseEvent) {
      if (!menuRef.current || menuRef.current.contains(event.target as Node)) return;
      setMenuOpen(false);
    }

    function handleFullscreenChange() {
      setIsFullscreen(document.fullscreenElement === shellRef.current);
    }

    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  function getViewer() {
    return runtimeRef.current?.pdfViewer || null;
  }

  function jumpToPage(page: number) {
    const viewer = getViewer();
    if (!viewer) return;
    const bounded = clamp(page, 1, Math.max(1, pageCount));
    viewer.currentPageNumber = bounded;
    setCurrentPage(bounded);
    setPageInput(String(bounded));
    setMenuOpen(false);
  }

  function updateScrollMode(nextMode: ScrollModeKey) {
    const runtime = runtimeRef.current;
    if (!runtime) return;

    const nextValue =
      nextMode === 'horizontal'
        ? runtime.pdfjsViewer.ScrollMode.HORIZONTAL
        : nextMode === 'wrapped'
          ? runtime.pdfjsViewer.ScrollMode.WRAPPED
          : runtime.pdfjsViewer.ScrollMode.VERTICAL;

    runtime.pdfViewer.scrollMode = nextValue;
    setScrollMode(nextMode);
    setMenuOpen(false);
  }

  function updateSpreadMode(nextMode: SpreadModeKey) {
    const runtime = runtimeRef.current;
    if (!runtime) return;

    const nextValue =
      nextMode === 'odd'
        ? runtime.pdfjsViewer.SpreadMode.ODD
        : nextMode === 'even'
          ? runtime.pdfjsViewer.SpreadMode.EVEN
          : runtime.pdfjsViewer.SpreadMode.NONE;

    runtime.pdfViewer.spreadMode = nextValue;
    setSpreadMode(nextMode);
    setMenuOpen(false);
  }

  function rotatePages(delta: number) {
    const viewer = getViewer();
    if (!viewer) return;
    const next = ((rotation + delta) % 360 + 360) % 360;
    viewer.pagesRotation = next;
    setRotation(next);
    setMenuOpen(false);
  }

  function zoomIn() {
    const viewer = getViewer();
    if (!viewer) return;
    viewer.increaseScale();
    setScalePercent(Math.round((Number(viewer.currentScale) || 1) * 100));
  }

  function zoomOut() {
    const viewer = getViewer();
    if (!viewer) return;
    viewer.decreaseScale();
    setScalePercent(Math.round((Number(viewer.currentScale) || 1) * 100));
  }

  function fitWidth() {
    const viewer = getViewer();
    if (!viewer) return;
    viewer.currentScaleValue = 'page-width';
    setScalePercent(Math.round((Number(viewer.currentScale) || 1) * 100));
  }

  function openInNewTab() {
    window.open(src, '_blank', 'noopener,noreferrer');
    setMenuOpen(false);
  }

  function savePdf() {
    const anchor = document.createElement('a');
    anchor.href = src;
    anchor.download = fileName || 'document.pdf';
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setMenuOpen(false);
  }

  function printPdf() {
    const printFrame = document.createElement('iframe');
    printFrame.style.position = 'fixed';
    printFrame.style.right = '0';
    printFrame.style.bottom = '0';
    printFrame.style.width = '0';
    printFrame.style.height = '0';
    printFrame.style.border = '0';
    printFrame.src = src;
    printFrame.onload = () => {
      window.setTimeout(() => {
        printFrame.contentWindow?.focus();
        printFrame.contentWindow?.print();
      }, 400);
    };
    document.body.appendChild(printFrame);
    window.setTimeout(() => printFrame.remove(), 10_000);
    setMenuOpen(false);
  }

  async function togglePresentationMode() {
    if (!shellRef.current) return;

    if (document.fullscreenElement === shellRef.current) {
      await document.exitFullscreen().catch(() => {});
    } else {
      await shellRef.current.requestFullscreen().catch(() => {});
    }
    setMenuOpen(false);
  }

  function beginHandTool(event: ReactPointerEvent<HTMLDivElement>) {
    if (toolMode !== 'hand' || event.button !== 0 || !containerRef.current) return;

    handStateRef.current = {
      dragging: true,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: containerRef.current.scrollLeft,
      scrollTop: containerRef.current.scrollTop,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveHandTool(event: ReactPointerEvent<HTMLDivElement>) {
    const state = handStateRef.current;
    if (!state.dragging || state.pointerId !== event.pointerId || !containerRef.current) return;

    const deltaX = event.clientX - state.startX;
    const deltaY = event.clientY - state.startY;
    containerRef.current.scrollLeft = state.scrollLeft - deltaX;
    containerRef.current.scrollTop = state.scrollTop - deltaY;
  }

  function endHandTool(event: ReactPointerEvent<HTMLDivElement>) {
    const state = handStateRef.current;
    if (!state.dragging || state.pointerId !== event.pointerId) return;

    handStateRef.current.dragging = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <div
      ref={shellRef}
      className={`pdfViewerShell ${isFullscreen ? 'fullscreen' : ''}`}
      data-tool-mode={toolMode}
    >
      <div className="pdfViewerToolbar">
        <div className="pdfViewerToolbarGroup">
          <button type="button" className="iconButton" onClick={zoomOut} title="축소" disabled={loading || Boolean(error)}>
            <Minus size={16} />
          </button>
          <button type="button" className="iconButton" onClick={zoomIn} title="확대" disabled={loading || Boolean(error)}>
            <ZoomIn size={16} />
          </button>
          <button type="button" className="pdfViewerPill" onClick={fitWidth} disabled={loading || Boolean(error)}>
            화면에 맞춤
          </button>
          <div className="pdfViewerStatusPill">{scalePercent}%</div>
        </div>

        <div className="pdfViewerToolbarGroup">
          <button type="button" className="iconButton" onClick={() => jumpToPage(1)} title="첫 페이지" disabled={loading || Boolean(error)}>
            <ChevronsLeft size={16} />
          </button>
          <div className="pdfViewerPageField">
            <input
              className="pdfViewerPageInput"
              inputMode="numeric"
              value={pageInput}
              onChange={(event) => setPageInput(event.target.value.replace(/[^\d]/g, '').slice(0, 5) || '1')}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  jumpToPage(Number.parseInt(pageInput || '1', 10) || 1);
                }
              }}
              aria-label="현재 페이지"
              disabled={loading || Boolean(error)}
            />
            <span>/ {pageCount || '-'}</span>
          </div>
          <button type="button" className="iconButton" onClick={() => jumpToPage(pageCount || 1)} title="마지막 페이지" disabled={loading || Boolean(error) || !pageCount}>
            <ChevronsRight size={16} />
          </button>
        </div>

        <div className="pdfViewerToolbarGroup pdfViewerToolbarMenuWrap" ref={menuRef}>
          <div className="pdfViewerStatusPill">
            {toolMode === 'hand' ? '손 도구' : '텍스트 선택'} · {scrollModeLabel}
          </div>
          <button
            type="button"
            className={`pdfViewerMenuButton ${menuOpen ? 'active' : ''}`}
            onClick={() => setMenuOpen((prev) => !prev)}
            aria-expanded={menuOpen}
            aria-label="PDF 뷰어 기능 열기"
          >
            뷰어 기능
            <ChevronDown size={16} />
          </button>

          {menuOpen ? (
            <div className="pdfViewerMenu">
              <div className="pdfViewerMenuGroup">
                <button type="button" className="pdfViewerMenuItem" onClick={openInNewTab}>
                  <ExternalLink size={16} />
                  Open
                </button>
                <button type="button" className="pdfViewerMenuItem" onClick={printPdf}>
                  <Printer size={16} />
                  Print
                </button>
                <button type="button" className="pdfViewerMenuItem" onClick={savePdf}>
                  <Download size={16} />
                  Save
                </button>
              </div>

              <div className="pdfViewerMenuGroup">
                <button type="button" className="pdfViewerMenuItem" onClick={() => void togglePresentationMode()}>
                  <Maximize size={16} />
                  {isFullscreen ? 'Exit Presentation Mode' : 'Presentation Mode'}
                </button>
                <button type="button" className="pdfViewerMenuItem" onClick={() => jumpToPage(currentPage)}>
                  <ScanLine size={16} />
                  Current Page
                </button>
              </div>

              <div className="pdfViewerMenuGroup">
                <button type="button" className="pdfViewerMenuItem" onClick={() => jumpToPage(1)}>
                  <ChevronsLeft size={16} />
                  Go to First Page
                </button>
                <button type="button" className="pdfViewerMenuItem" onClick={() => jumpToPage(pageCount || 1)}>
                  <ChevronsRight size={16} />
                  Go to Last Page
                </button>
              </div>

              <div className="pdfViewerMenuGroup">
                <button type="button" className="pdfViewerMenuItem" onClick={() => rotatePages(90)}>
                  <RotateCw size={16} />
                  Rotate Clockwise
                </button>
                <button type="button" className="pdfViewerMenuItem" onClick={() => rotatePages(-90)}>
                  <RotateCcw size={16} />
                  Rotate Counterclockwise
                </button>
              </div>

              <div className="pdfViewerMenuGroup">
                <button
                  type="button"
                  className={`pdfViewerMenuItem ${toolMode === 'text' ? 'selected' : ''}`}
                  onClick={() => {
                    setToolMode('text');
                    setMenuOpen(false);
                  }}
                >
                  <Type size={16} />
                  Text Selection Tool
                </button>
                <button
                  type="button"
                  className={`pdfViewerMenuItem ${toolMode === 'hand' ? 'selected' : ''}`}
                  onClick={() => {
                    setToolMode('hand');
                    setMenuOpen(false);
                  }}
                >
                  <Hand size={16} />
                  Hand Tool
                </button>
              </div>

              <div className="pdfViewerMenuGroup">
                <div className="pdfViewerMenuLabel">Page Scrolling</div>
                <button type="button" className={`pdfViewerMenuItem ${scrollMode === 'vertical' ? 'selected' : ''}`} onClick={() => updateScrollMode('vertical')}>
                  <ScrollText size={16} />
                  Vertical Scrolling
                </button>
                <button type="button" className={`pdfViewerMenuItem ${scrollMode === 'horizontal' ? 'selected' : ''}`} onClick={() => updateScrollMode('horizontal')}>
                  <ScanLine size={16} />
                  Horizontal Scrolling
                </button>
                <button type="button" className={`pdfViewerMenuItem ${scrollMode === 'wrapped' ? 'selected' : ''}`} onClick={() => updateScrollMode('wrapped')}>
                  <WrapText size={16} />
                  Wrapped Scrolling
                </button>
              </div>

              <div className="pdfViewerMenuGroup">
                <div className="pdfViewerMenuLabel">Spread Mode</div>
                <button type="button" className={`pdfViewerMenuItem ${spreadMode === 'none' ? 'selected' : ''}`} onClick={() => updateSpreadMode('none')}>
                  <ScanLine size={16} />
                  No Spreads
                </button>
                <button type="button" className={`pdfViewerMenuItem ${spreadMode === 'odd' ? 'selected' : ''}`} onClick={() => updateSpreadMode('odd')}>
                  <ScanLine size={16} />
                  Odd Spreads
                </button>
                <button type="button" className={`pdfViewerMenuItem ${spreadMode === 'even' ? 'selected' : ''}`} onClick={() => updateSpreadMode('even')}>
                  <ScanLine size={16} />
                  Even Spreads
                </button>
              </div>

              <div className="pdfViewerMenuGroup">
                <button
                  type="button"
                  className="pdfViewerMenuItem"
                  onClick={() => {
                    setPropertiesOpen(true);
                    setMenuOpen(false);
                  }}
                >
                  <Info size={16} />
                  Document Properties
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div
        ref={containerRef}
        className={`pdfViewerViewport ${toolMode === 'hand' ? 'handMode' : ''}`}
        onPointerDown={beginHandTool}
        onPointerMove={moveHandTool}
        onPointerUp={endHandTool}
        onPointerCancel={endHandTool}
      >
        <div ref={viewerRef} className="pdfViewer" />
        {loading ? <div className="pdfViewerOverlay">PDF를 불러오는 중...</div> : null}
        {error ? <div className="pdfViewerOverlay error">{error}</div> : null}
      </div>

      <div className="pdfViewerFooter">
        <div>현재 {currentPage} / {pageCount || '-'}페이지</div>
        <div>{scrollModeLabel} · {spreadModeLabel} · 회전 {rotation}°</div>
      </div>

      {propertiesOpen ? (
        <div className="pdfViewerPropertiesBackdrop" onClick={() => setPropertiesOpen(false)}>
          <div className="pdfViewerPropertiesCard" onClick={(event) => event.stopPropagation()}>
            <div className="pdfViewerPropertiesHeader">
              <div>
                <div className="sectionTitle">Document Properties</div>
                <div className="muted">{fileName}</div>
              </div>
              <button type="button" className="iconButton" onClick={() => setPropertiesOpen(false)} aria-label="문서 정보 닫기">
                <X size={16} />
              </button>
            </div>
            <div className="pdfViewerPropertiesGrid">
              <div className="pdfViewerPropertyItem"><span>페이지 수</span><strong>{pageCount || '-'}</strong></div>
              <div className="pdfViewerPropertyItem"><span>현재 페이지</span><strong>{currentPage}</strong></div>
              <div className="pdfViewerPropertyItem"><span>제목</span><strong>{docProperties.title || '-'}</strong></div>
              <div className="pdfViewerPropertyItem"><span>작성자</span><strong>{docProperties.author || '-'}</strong></div>
              <div className="pdfViewerPropertyItem"><span>주제</span><strong>{docProperties.subject || '-'}</strong></div>
              <div className="pdfViewerPropertyItem"><span>Creator</span><strong>{docProperties.creator || '-'}</strong></div>
              <div className="pdfViewerPropertyItem"><span>Producer</span><strong>{docProperties.producer || '-'}</strong></div>
              <div className="pdfViewerPropertyItem"><span>Keywords</span><strong>{docProperties.keywords || '-'}</strong></div>
              <div className="pdfViewerPropertyItem"><span>생성일</span><strong>{docProperties.creationDate || '-'}</strong></div>
              <div className="pdfViewerPropertyItem"><span>수정일</span><strong>{docProperties.modificationDate || '-'}</strong></div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
