'use client';

import { useState } from 'react';

export function UploadPanel({ projectId }: { projectId: string }) {
  const [pdfName, setPdfName] = useState('');
  const [audioName, setAudioName] = useState('');

  return (
    <form className="card stack" style={{ gridColumn: 'span 5' }} action="/api/ingest" method="post" encType="multipart/form-data">
      <input type="hidden" name="projectId" value={projectId} />
      <div>
        <label className="label">PDF 파일</label>
        <input
          className="input"
          type="file"
          name="pdf"
          accept="application/pdf"
          required
          onChange={(e) => setPdfName(e.target.files?.[0]?.name || '')}
        />
        <div className="muted" style={{ marginTop: 8, fontSize: 13 }}>
          업로드하면 AI가 PDF 본문을 분석해 과목을 자동 추정합니다. 직접 과목을 고르지 않아도 돼요.
        </div>
        {pdfName ? <div className="fileBadge">선택된 PDF · {pdfName}</div> : null}
      </div>
      <div>
        <label className="label">녹음 파일</label>
        <input
          className="input"
          type="file"
          name="audio"
          accept="audio/*"
          onChange={(e) => setAudioName(e.target.files?.[0]?.name || '')}
        />
        <div className="muted" style={{ marginTop: 8, fontSize: 13 }}>
          선택 사항이에요. 교수님 강조 내용이 있으면 같이 분석해서 필기에 반영합니다.
        </div>
        {audioName ? <div className="fileBadge">선택된 오디오 · {audioName}</div> : null}
      </div>
      <button className="button" type="submit">자료 업로드</button>
    </form>
  );
}
