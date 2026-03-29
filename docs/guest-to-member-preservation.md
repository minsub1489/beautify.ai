# 비회원 PDF 체험 → 회원 전환 시 데이터 보존 설계

## 목표

- 비회원이 업로드한 PDF, 편집 결과, 필기 PDF, 퀴즈 결과를 로그인 후에도 그대로 이어서 사용하게 한다.
- 회원 전환 과정에서 프로젝트 ID를 바꾸지 않고, 기존 자산과 생성 기록을 그대로 유지한다.
- 로그인 사용자 데이터와 비회원 체험 데이터를 명확히 분리해 권한 누수를 막는다.

## 현재 구조에서의 한계

현재 코드 기준으로는 `Project`가 로그인 사용자나 비회원 세션에 귀속되지 않는다.

- [Project 모델](/Users/minsub/Documents/beautify-ai/beautify/prisma/schema.prisma)는 소유자 필드가 없다.
- [sessionToUserId](/Users/minsub/Documents/beautify-ai/beautify/lib/auth.ts)는 로그인 사용자의 식별자만 만든다.
- [getCurrentUserId](/Users/minsub/Documents/beautify-ai/beautify/lib/auth-user.ts)는 미로그인 상태에서 `demo-user`를 반환하는데, 이 값은 결제/크레딧용 fallback으로는 가능하지만 프로젝트 소유권 식별자로 쓰기에는 위험하다.
- [홈 로딩](/Users/minsub/Documents/beautify-ai/beautify/app/page.tsx)은 현재 모든 프로젝트를 그대로 불러온다.

즉, 지금 상태에서는 "비회원 체험 데이터를 로그인 후 이어받기" 이전에 "누구의 프로젝트인지"부터 구분해야 한다.

## 설계 원칙

- 프로젝트 소유권과 결제 사용자 ID를 분리한다.
- 비회원 데이터도 서버에 저장하되, 브라우저 쿠키 기반의 임시 세션으로 귀속한다.
- 회원 전환 시에는 데이터를 복사하지 않고 프로젝트의 소유권만 안전하게 이전한다.
- 필기/퀴즈/번역/PDF 편집 결과는 모두 `projectId`에 연결되어 있으므로, `projectId`를 유지하는 방향으로 설계한다.
- 로그인 전 체험 데이터는 영구 보관하지 않고 만료 정책을 둔다.

## 권장 아키텍처

### 1. Workspace Actor 분리

새로운 공통 식별 개념을 둔다.

- `user` actor: 로그인 사용자의 `userId`
- `guest` actor: 비회원 세션의 `guestSessionId`

이 값은 결제용 `getCurrentUserId()`와 별도로 관리한다.

추천 유틸:

- `getWorkspaceActor()`
  - 로그인 시: `{ type: 'user', userId }`
  - 비로그인 시: `{ type: 'guest', guestSessionId }`

## 데이터 모델

### 최소 변경안

`Project`에 소유권 필드를 추가한다.

```prisma
enum ProjectOwnerType {
  guest
  user
}

model Project {
  id             String           @id @default(cuid())
  title          String
  subject        String?
  description    String?
  sortOrder      Int              @default(0)
  ownerType      ProjectOwnerType @default(guest)
  ownerUserId    String?
  guestSessionId String?
  claimedAt      DateTime?
  guestExpiresAt DateTime?
  createdAt      DateTime         @default(now())
  updatedAt      DateTime         @updatedAt
  assets         Asset[]
  runs           GenerationRun[]
  messages       ProjectMessage[]

  @@index([ownerType, ownerUserId, updatedAt])
  @@index([ownerType, guestSessionId, updatedAt])
}
```

### 추천 이유

- 기존 `Asset`, `GenerationRun`, `ProjectMessage`는 `projectId`만 유지하면 된다.
- 소유권 이전 시 `Project` 한 줄만 업데이트하면 연결된 PDF/필기/퀴즈 기록이 그대로 살아남는다.
- 삭제나 다운로드 권한 체크도 `Project` 기준으로 통일할 수 있다.

## 비회원 세션 발급 방식

### 쿠키

- 이름 예시: `beautify_guest_session`
- 형식: 충분히 긴 랜덤 문자열 또는 UUID
- 속성:
  - `httpOnly`
  - `sameSite=lax`
  - `secure` in production
  - `maxAge`: 7일 또는 14일

### 발급 시점

- 첫 방문 시 바로 발급하거나
- 첫 프로젝트 생성 / 첫 PDF 업로드 시 발급

추천은 "첫 쓰기 시점 발급"이다. 불필요한 게스트 세션을 줄일 수 있다.

## 프로젝트 생성/조회/수정 흐름

### 비회원

1. 사용자가 PDF 업로드 또는 프로젝트 생성
2. 서버가 `beautify_guest_session` 쿠키를 확인
3. 없으면 생성
4. 새 `Project`를 `ownerType=guest`, `guestSessionId=<cookie>`로 저장
5. 이후 PDF 편집, 필기 생성, 퀴즈 생성도 모두 같은 `guestSessionId`를 기준으로 허용

### 회원

1. 로그인된 사용자는 `sessionToUserId()`로 `userId` 확보
2. 새 `Project`는 `ownerType=user`, `ownerUserId=<userId>`로 저장
3. 조회 시에도 본인 `ownerUserId`에 해당하는 프로젝트만 반환

## 로그인 후 데이터 보존 방식

핵심은 `복사`가 아니라 `claim`이다.

### Claim API

추천 엔드포인트:

- `POST /api/auth/claim-guest-projects`

동작:

1. 현재 로그인 세션 확인
2. 브라우저의 `beautify_guest_session` 확인
3. 아래 조건의 프로젝트를 한 번에 이전
   - `ownerType = guest`
   - `guestSessionId = 현재 쿠키 값`
4. 각 프로젝트를 아래처럼 업데이트
   - `ownerType = user`
   - `ownerUserId = 현재 로그인 사용자`
   - `guestSessionId = null`
   - `guestExpiresAt = null`
   - `claimedAt = now()`

중요:

- 프로젝트 ID는 유지한다.
- `Asset`, `GenerationRun`, `ProjectMessage`는 변경하지 않는다.
- 이 흐름은 같은 요청이 여러 번 와도 안전하도록 idempotent하게 만든다.

## 권장 UX 흐름

### 비회원 체험 중

- 상단 또는 업로드 영역에 안내 문구 표시
  - `비회원 체험 중입니다. 로그인하면 작업한 PDF와 필기를 이어서 저장할 수 있어요.`

### 로그인 직후

비회원 데이터가 있을 때만 가벼운 확인 UI를 보여준다.

- 제목: `체험 데이터를 현재 계정으로 가져올까요?`
- 설명:
  - 업로드한 PDF
  - PDF 편집 상태
  - 생성된 필기 PDF
  - 퀴즈 결과
  를 그대로 이어서 사용할 수 있다고 안내
- 액션:
  - `가져오기`
  - `나중에`

### 가져오기 성공 후

- 토스트 예시: `비회원 체험 데이터 3개를 내 계정으로 가져왔어요.`

## 보존 범위

회원 전환 시 보존 대상:

- 프로젝트 메타데이터
- 업로드한 원본 PDF
- PDF 편집 결과
- 생성된 필기 PDF
- 생성된 퀴즈와 오답노트
- 번역 PDF
- 프로젝트 메시지 히스토리

보존하지 않거나 별도 정책이 필요한 항목:

- 비회원 상태에서의 무료 체험 크레딧
- 결제 정보
- 자동충전 설정

즉, "학습 데이터"는 가져오고 "결제 상태"는 가져오지 않는다.

## 권한 규칙

모든 프로젝트 관련 API는 `projectId`만 받지 말고 현재 actor가 해당 프로젝트의 소유자인지 검사해야 한다.

적용 대상 예시:

- 프로젝트 목록 조회
- 프로젝트 이름 수정
- 프로젝트 삭제
- PDF 업로드
- PDF 원본/페이지 미리보기 다운로드
- 필기 생성
- 퀴즈 생성
- 번역 생성
- PDF 편집 저장

권한 검사 공통 함수 예시:

```ts
assertProjectAccess(project, actor)
```

## 만료 정책

비회원 데이터는 저장 비용이 큰 편이므로 만료 정책이 필요하다.

- 기본 보존 기간: 마지막 활동 기준 7일
- 로그인 후 claim되면 만료 제거
- 만료 대상:
  - `ownerType=guest`
  - `guestExpiresAt < now()`

정리 작업:

- cron 또는 배치로 만료 프로젝트 삭제
- 관련 `Asset` 파일도 같이 정리

## 충돌 처리 규칙

### 같은 브라우저에서 기존 회원 프로젝트가 이미 있을 때

- guest 프로젝트를 현재 계정에 추가만 한다.
- 기존 회원 프로젝트와 합치지 않는다.

### 다른 계정으로 로그인할 때

- 같은 브라우저에 남아 있던 guest 프로젝트는 현재 로그인한 계정으로 claim된다.
- 따라서 로그인 직후 확인 UI를 두는 것이 안전하다.

### 여러 탭에서 동시에 claim될 때

- `updateMany` + 조건부 where로 한 번만 이전되게 만든다.
- 이미 이전된 프로젝트는 건너뛴다.

## 현재 코드에 적용할 때의 구조 변경

### 새 유틸 추가

- `lib/workspace-actor.ts`
  - 현재 요청의 actor 계산
- `lib/guest-session.ts`
  - 게스트 쿠키 발급/조회
- `lib/project-access.ts`
  - 프로젝트 권한 확인

### 수정 대상

- [홈 로딩](/Users/minsub/Documents/beautify-ai/beautify/app/page.tsx)
  - 현재 actor의 프로젝트만 조회
- [프로젝트 API](/Users/minsub/Documents/beautify-ai/beautify/app/api/projects/route.ts)
  - 생성 시 actor 기준 owner 저장
- [필기/퀴즈 생성 API](/Users/minsub/Documents/beautify-ai/beautify/app/api/generate/route.ts)
  - project access 검사
- PDF 관련 route 전체
  - asset/project 접근 권한 검사

## 단계별 구현 순서

### 1단계

- `Project`에 owner 필드 추가
- guest session cookie 유틸 추가
- 신규 프로젝트 생성 시 owner 저장

### 2단계

- 프로젝트 조회/수정/삭제를 actor 기준으로 제한
- PDF/필기/퀴즈/번역 route에 권한 검사 추가

### 3단계

- 로그인 후 `claim-guest-projects` API 추가
- 로그인 직후 가져오기 UI 추가

### 4단계

- guest 만료 정리 작업 추가
- 운영 로그/분석 추가

## 마이그레이션 전략

현재는 모든 프로젝트가 소유자 없이 존재하므로 바로 전환하면 기존 데이터 접근이 깨질 수 있다.

권장 방식:

1. owner 필드를 nullable로 먼저 추가
2. 새로 생성되는 프로젝트부터만 guest/user owner를 기록
3. 기존 레거시 프로젝트는 임시로 `legacy` 취급
4. 관리자용 일괄 귀속 스크립트 또는 첫 로그인 시 선택 귀속 도구를 별도로 만든다
5. 레거시 정리가 끝나면 owner 없는 프로젝트 조회를 막는다

## 테스트 시나리오

반드시 확인할 시나리오:

1. 비회원으로 PDF 업로드 후 로그인했을 때 프로젝트가 그대로 보인다
2. 비회원으로 PDF 편집 후 로그인했을 때 편집 결과가 유지된다
3. 비회원으로 필기 생성 후 로그인했을 때 생성 PDF가 유지된다
4. 비회원으로 퀴즈 풀이 후 로그인했을 때 오답노트가 유지된다
5. 다른 브라우저에서는 guest 데이터가 보이지 않는다
6. claim를 두 번 호출해도 중복 프로젝트가 생기지 않는다
7. guest 만료 후에는 데이터가 정리된다

## 결론

이 기능의 핵심은 "비회원 데이터 복사"가 아니라 "프로젝트 소유권 이전"이다.

현재 Beautify 구조에서는 `Project`에 `guest/user owner` 개념만 추가해도 PDF, 필기, 퀴즈, 번역, 메시지 기록을 거의 그대로 살릴 수 있다. 따라서 가장 현실적인 구현은:

1. 비회원 쿠키 기반 `guestSessionId` 도입
2. `Project` 소유권 필드 추가
3. 로그인 후 `claim` 트랜잭션으로 guest 프로젝트를 user 프로젝트로 전환

이 순서로 가는 것이다.
