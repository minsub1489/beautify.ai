# Beautify

Beautify는 PDF 기반 학습 워크스페이스입니다.  
PDF를 업로드하고, 페이지를 편집하고, PDF 위에 직접 필기를 생성하고, 선택한 페이지 범위만 분석해서 시험 대비 퀴즈를 만들 수 있습니다.

## 주요 기능

- 중앙 미리보기에서 PDF 업로드, 확인, 제거
- 미리보기 기준 PDF 다운로드
- PDF 편집 모드
  - 페이지 드래그앤드롭 순서 변경
  - 페이지 삭제
  - 다른 PDF를 현재 PDF 앞/뒤로 병합
- PDF 위 직접 필기 생성
  - 필기는 별도 메모창이 아니라 원본 PDF 페이지 안에 삽입되어 새 필기 PDF로 생성됩니다
  - 필기 생성 시 페이지 범위를 직접 선택할 수 있습니다
  - 마음에 들지 않는 페이지는 페이지별로 다시 생성할 수 있습니다
- 시험 대비 퀴즈 생성
  - 퀴즈도 페이지 범위를 선택해서 생성합니다
  - 단답형 / OX / 4지선다를 섞어서 생성합니다
  - 한 문제씩 표시되고 남은 문제 수와 진행도가 보입니다
  - 실시간 정오답 표시, 오답노트, 오답 개념 변형 재시험을 지원합니다
  - 퀴즈는 반드시 선택한 PDF 페이지 내용을 분석해서 한국어로 생성합니다
- PDF 번역 보기
  - 미리보기 오른쪽 위 번역 버튼으로 한국어 번역 PDF를 볼 수 있습니다
  - 다시 누르면 원문 보기로 돌아갑니다
  - DeepL API를 사용합니다
- 프로젝트 관리
  - 프로젝트 순서 드래그앤드롭 변경
  - 프로젝트 삭제 전 확인 팝업
- 자연스러운 라이트/다크 모드 전환

## AI 동작 방식

- AI API를 사용하는 핵심 기능은 `필기 생성`과 `퀴즈 생성`입니다
- 퀴즈는 항상 실제 PDF 본문을 기준으로 생성됩니다
- 외부 AI 사용 순서는 다음과 같습니다
  - `Gemini -> OpenAI -> OpenRouter -> Groq -> Together -> HuggingFace`
- 토큰 절약용 옵션
  - `AI_LOW_TOKEN_MODE=true`: 더 짧은 컨텍스트로 생성
  - `AI_USE_LOCAL_PIPELINE=true`: 외부 AI 대신 로컬 경량 파이프라인 사용

중요:
- 진짜 AI가 PDF를 분석해서 필기/퀴즈를 만들게 하려면 `.env`에서 `AI_USE_LOCAL_PIPELINE=false`로 바꿔 주세요
- 기본 예시는 비용 절약을 위해 로컬 파이프라인 모드가 켜져 있습니다

## 빠른 시작

```bash
npm install
cp .env.example .env
```

필수 설정:
- `DATABASE_URL`
- `NEXTAUTH_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

AI 기능을 실제 API로 사용하려면 최소 1개 이상:
- `GEMINI_API_KEY` 권장
- 또는 `OPENAI_API_KEY`
- 또는 `OPENROUTER_API_KEY`
- 또는 `GROQ_API_KEY`
- 또는 `TOGETHER_API_KEY`
- 또는 `HUGGINGFACE_API_KEY`

번역 기능을 쓰려면:
- `DEEPL_API_KEY`

선택 설정:
- `BLOB_READ_WRITE_TOKEN`: Vercel Blob 저장소 사용 시
- `PDF_ANNOTATION_FONT_PATH`: 한글 PDF 필기용 커스텀 폰트 경로
- `NOTION_TOKEN`: Notion 연동 사용 시
- `MAX_FILE_MB`: 업로드 최대 크기

추천 설정:
- `AI_USE_LOCAL_PIPELINE=false`
- `AI_LOW_TOKEN_MODE=true`

## 실행

```bash
npx prisma db push
npm run dev
```

참고:
- `npm run dev`, `npm run start`, `npm run build`는 실행 전에 자동으로 `prisma generate`를 수행합니다

브라우저:
- `http://localhost:3000`

Google OAuth Redirect URI:
- `http://localhost:3000/api/auth/callback/google`

## 사용 흐름

1. 프로젝트를 만들거나 기존 프로젝트를 선택합니다
2. 중앙 미리보기 영역에 PDF를 드롭하거나 업로드합니다
3. 필요하면 `편집` 모드에서 페이지 순서 변경, 삭제, 다른 PDF 병합을 진행합니다
4. `필기` 탭에서 시작/끝 페이지를 정하고 생성합니다
5. `퀴즈` 탭에서 시작/끝 페이지를 정하고 퀴즈를 생성합니다
6. 필요하면 번역 보기, 페이지별 필기 재생성, PDF 다운로드를 사용합니다

## 환경 변수 예시

전체 예시는 `.env.example`에 있습니다.

자주 쓰는 항목만 보면:

```env
GEMINI_API_KEY=
OPENAI_API_KEY=
OPENROUTER_API_KEY=
GROQ_API_KEY=
TOGETHER_API_KEY=
HUGGINGFACE_API_KEY=
DEEPL_API_KEY=

AI_LOW_TOKEN_MODE=true
AI_USE_LOCAL_PIPELINE=false

DATABASE_URL=
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

## 개발 메모

- Prisma 스키마를 바꾼 뒤에는 `npx prisma db push`를 다시 실행하세요
- 실행 중 `Unknown argument sortOrder` 같은 오류가 나면 Prisma Client가 예전 상태일 수 있으니 서버를 재시작하세요
- 민감정보는 커밋하지 말고 `.env.example`만 추적하세요

## 설계 문서

- [비회원 PDF 체험 → 회원 전환 시 데이터 보존 설계](/Users/minsub/Documents/beautify-ai/beautify/docs/guest-to-member-preservation.md)

## 이름

이 프로젝트의 앱 이름은 `Beautify`입니다.
