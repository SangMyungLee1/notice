# notice.life-helper.co.kr 관리자 글쓰기 게시판

이 압축파일은 `notice.life-helper.co.kr`에서 사용할 수 있는 정적 HTML 게시판 + 관리자 글쓰기 기능 세트입니다.

## 포함 기능

- `/ab-qna/` 게시판 목록
- `/admin/password.html` 비밀번호 입력 전용 페이지
- `/admin/write.html` 글쓰기 에디터 페이지
- 글쓰기 화면 상단의 `이미지 추가` 버튼
- 이미지 버튼 클릭 시 작은 업로드 창 표시
- 업로드 창 안에 이미지 드래그 앤 드롭
- 이미지 자동 업로드 후 본문 자동 삽입
- 저장 시 새 HTML 게시글 자동 생성
- `index.html`, `/ab-qna/index.html`, `sitemap.xml`, `rss.xml`, `data/posts.json` 자동 갱신

## 업로드 방법

압축을 푼 뒤 안의 파일과 폴더 전체를 GitHub 저장소 최상단에 그대로 올립니다.

Cloudflare Pages 설정은 기존처럼 아래 값을 사용하면 됩니다.

```text
Framework preset: None
Build command: exit 0
Build output directory: .
```

## Cloudflare 환경 변수 설정

Cloudflare Pages 프로젝트에서 아래 환경 변수를 설정해야 저장 기능이 작동합니다.

경로 예시:

```text
Cloudflare Dashboard
→ Workers & Pages
→ 해당 Pages 프로젝트
→ Settings
→ Environment variables
```

필수 환경 변수:

```text
ADMIN_PASSWORD=관리자 비밀번호
ADMIN_TOKEN_SECRET=아무도 모르는 긴 랜덤 문자열
GITHUB_TOKEN=GitHub 토큰
GITHUB_OWNER=GitHub 사용자명 또는 조직명
GITHUB_REPO=저장소 이름
GITHUB_BRANCH=main
SITE_URL=https://notice.life-helper.co.kr
```

권장 예시:

```text
ADMIN_PASSWORD=내가쓸비밀번호
ADMIN_TOKEN_SECRET=notice-board-secret-very-long-random-text-2026
GITHUB_OWNER=my-github-id
GITHUB_REPO=my-repository-name
GITHUB_BRANCH=main
SITE_URL=https://notice.life-helper.co.kr
```

`ADMIN_PASSWORD`, `ADMIN_TOKEN_SECRET`, `GITHUB_TOKEN`은 일반 변수보다 Secret으로 넣는 것을 권장합니다.

## GitHub 토큰 권한

GitHub Fine-grained personal access token을 만들 때 저장소를 선택하고 아래 권한을 줍니다.

```text
Repository permissions
Contents: Read and write
Metadata: Read-only
```

이 토큰은 글 저장 시 GitHub 저장소에 HTML 파일과 이미지 파일을 자동 커밋하는 데 사용됩니다.

## 실제 사용 흐름

```text
/ab-qna/
→ 글쓰기 버튼 클릭
→ /admin/password.html 이동
→ 비밀번호 입력
→ /admin/write.html 이동
→ 이미지 추가 버튼 클릭
→ 작은 이미지 업로드 창에 이미지 드래그
→ 이미지가 자동 업로드되고 본문에 삽입
→ 제목 입력
→ 내용 입력
→ 저장하기
→ GitHub에 새 HTML 파일 자동 생성
→ Cloudflare Pages 자동 재배포
```

## 생성되는 파일 예시

새 글을 저장하면 아래 파일들이 자동 갱신됩니다.

```text
ab-qna/ab-qna_v-1011.html
ab-qna/index.html
index.html
sitemap.xml
rss.xml
data/posts.json
```

이미지를 올리면 아래처럼 저장됩니다.

```text
uploads/2026/07/업로드파일명.jpg
```

## 주의사항

- Cloudflare 환경 변수를 설정한 뒤에는 재배포가 한 번 필요할 수 있습니다.
- 저장 버튼을 누른 직후에는 GitHub 커밋과 Cloudflare 재배포 시간이 조금 걸릴 수 있습니다.
- GitHub 토큰 권한이 부족하면 이미지 업로드나 글 저장이 실패합니다.
- 이미지 파일은 기본 5MB 이하만 업로드되도록 설정되어 있습니다.
- 비밀번호는 HTML 안에 들어가지 않고 Cloudflare Function에서 검사합니다.


## 2026-07-01 재수정 사항
- 저장 직후 목록 이동 시 로컬 임시 게시글을 합쳐서 방금 작성한 글이 목록 상단에 즉시 보이도록 수정했습니다.
- 이미지 업로드 후 본문에는 실제 이미지가 표시되고, 저장 시 배포용 이미지 경로로 변환됩니다.
- `/ab-qna/`, `/admin/`, `/api/` 쪽 캐시를 줄여 업데이트 확인이 쉽도록 했습니다.

## 2026-07-01 에디터 추가 수정 사항
- 에디터 툴바의 `굵게` 왼쪽에 `URL` 버튼을 추가했습니다.
- 에디터 안에서 텍스트 또는 이미지를 선택한 뒤 URL 버튼으로 링크를 적용할 수 있습니다.
- `소제목` 오른쪽에 상단 `저장하기` 버튼을 추가했습니다.
- 저장 성공 후 안내 문구와 딜레이 없이 바로 `/ab-qna/` 목록으로 이동합니다.
- 에디터 카드와 본문 에디터의 가로·세로 크기를 약간 줄였습니다.
- 긴 글이나 이미지가 많을 때 에디터 내부에 스크롤바가 생기도록 조정했습니다.
- 이미지 여러 장을 한 번에 드래그하거나 파일 선택으로 다중 업로드할 수 있습니다.
- 비밀번호 확인 페이지 진입 시 비밀번호 입력칸에 자동 포커스가 적용됩니다.


## Open Graph 자동 생성

- `/index.html`, `/ab-qna/index.html`, 기존 개별 게시글 HTML에 Open Graph 제목과 설명을 추가했습니다.
- 앞으로 관리자 글쓰기에서 새 글을 저장하면 `functions/api/[[path]].js`가 게시글 제목과 본문 요약을 이용해 `og:title`, `og:description`, `og:url`, `og:type`을 자동 생성합니다.
- 본문에 이미지가 포함된 경우 첫 번째 이미지를 `og:image`로 자동 지정합니다.


## 이번 추가 검수 수정

- 본문 에디터 높이를 330px 고정으로 조정했습니다.
- 긴 글이나 이미지 여러 장을 넣어도 에디터 박스 내부에 세로 스크롤바가 항상 표시되도록 강화했습니다.
- 에디터 가로폭을 약간 줄여 화면에서 과하게 넓어 보이지 않도록 조정했습니다.
- 이미지 삽입 후 에디터 내부 스크롤이 삽입 위치 쪽으로 이동하도록 보완했습니다.
- 저장 중 안내 문구 표시를 제거하고, 성공 시 즉시 목록으로 이동하는 구조를 유지했습니다.
