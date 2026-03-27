# AI Note Studio v4 Workspace

AI 기반 PDF 필기 생성/미리보기 웹앱입니다.  
현재 인증은 Google OAuth(NextAuth), AI 모델은 Gemini 기준입니다.

## Local Setup
```bash
npm install
cp .env.example .env
```

`.env` 필수 값:
- `DATABASE_URL`
- `GEMINI_API_KEY`
- `NEXTAUTH_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

Google OAuth Redirect URI:
- `http://localhost:3000/api/auth/callback/google`

실행:
```bash
npx prisma generate
npx prisma db push
npm run dev
```

브라우저:
- `http://localhost:3000`

## GitHub 운영 규칙
- 민감정보는 절대 커밋하지 않음 (`.env*` 무시, `.env.example`만 추적)
- `main` 브랜치 중심으로 PR 머지
- CI(`.github/workflows/ci.yml`)에서 타입체크 자동 실행

## 첫 GitHub 업로드
```bash
git init
git add .
git commit -m "chore: initial project import"
git branch -M main
git remote add origin <YOUR_GITHUB_REPO_URL>
git push -u origin main
```

## 주의
기존에 노출된 API 키/시크릿이 있다면 즉시 재발급(rotate)하세요.

