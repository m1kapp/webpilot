# Webwing · 내 연차 (크롬 확장)

타임인아웃에 **이미 로그인된 세션**을 빌려 내 연차 잔여와 사용 내역을 연간 달력으로 보여준다.
아이디·비밀번호를 묻지도, 저장하지도 않는다.

---

## 받는 사람용 (직원)

1. 공지에 있는 설치 링크를 눌러 **크롬에 추가**
2. [타임인아웃](https://user.timeinout.kr/)에 로그인
3. 크롬 툴바의 Webwing 아이콘 클릭

조회 중에는 백그라운드 탭이 잠깐 열렸다 닫힌다. 정상이다.

**"로그인되어 있지 않습니다"가 뜨면** 타임인아웃 로그인이 풀린 것이다. 로그인한 뒤 화면의 `불러오기`를 다시 누르면 된다.

---

## 개발자용

### 구조

```
extension/
  manifest.json       권한 선언. host_permissions는 타임인아웃 한 도메인뿐
  background.js       서비스 워커. server.mjs의 라우트 자리
  lib/tab.js          Playwright page 조작을 대신하는 어댑터 (openTab/evaluate/goto/closeTab)
  lib/timeinout.js    수집 계층. src/lib/timeinout.mjs의 fetchEmployeeLeaves에 대응
  page/               결과 화면. public/index.html의 연차 화면을 옮겨 온 것
  core/               src/core 사본 (생성물 — 직접 수정 금지)
```

### 코어는 공유, 수집만 갈라진다

계산·파싱·달력은 `src/core/`에 있고 데스크톱판과 **같은 코드**를 쓴다.
확장은 `.mjs` 모듈 MIME 문제와 zip 심볼릭 링크 문제를 피하려고 사본을 둔다:

```bash
npm run ext:sync    # src/core/*.mjs → extension/core/*.js
```

`src/core/`를 고쳤으면 이걸 다시 돌려야 확장에 반영된다.

### 로컬에서 실행

```bash
npm run ext:sync
```

1. `chrome://extensions` 접속
2. 우측 상단 **개발자 모드** 켜기
3. **압축해제된 확장 프로그램을 로드** → 이 `extension/` 폴더 선택
4. 타임인아웃에 로그인한 상태로 툴바 아이콘 클릭

코드를 고친 뒤에는 확장 카드의 **새로고침** 버튼을 눌러야 반영된다.

### 디버깅

| 증상 | 볼 곳 |
|---|---|
| 아무 반응 없음 | `chrome://extensions` → 확장 카드의 **서비스 워커** 링크 → 콘솔 |
| 결과가 빔 | 타임인아웃 로그인 상태. `lib/timeinout.js`의 `assertLoggedIn`이 먼저 걸러 준다 |
| 화면 오류 | 결과 탭에서 개발자도구 (일반 웹페이지와 동일) |

서비스 워커는 놀면 종료된다. 조회 중에는 살아 있지만, **전역 변수에 상태를 담아두면 안 된다**. 필요하면 `chrome.storage`를 쓴다.

### 페이지에서 꺼내고, 백그라운드에서 해석한다

`chrome.scripting.executeScript`에 넘기는 함수는 문자열로 직렬화돼 페이지로 건너간다.
바깥 변수와 `import`를 데려갈 수 없으므로 역할을 나눈다:

- **페이지 안** — `innerText`, `querySelectorAll` 결과 등 **원문만** 꺼낸다
- **백그라운드** — 꺼내 온 원문을 코어의 정규식·계산으로 처리한다

이 분리 덕분에 `innerText`가 실제로 렌더된 화면에서 나오고, 데스크톱판 정규식이 그대로 동작한다.
(`fetch` + `DOMParser`로 파싱하면 `innerText`가 비어 정규식이 깨진다. 휴가 종류를 확인하는
상세페이지 조회에서 화면 밖 오프스크린 요소를 쓰는 것도 같은 이유다 — `display:none`은 `innerText`를 비운다.)

### 스토어 배포

```bash
npm run ext:zip     # dist/webwing-extension-0.1.0.zip
```

1. [개발자 대시보드](https://chrome.google.com/webstore/devconsole)에서 등록비 5달러 1회 결제
2. 새 항목 → zip 업로드
3. 공개 상태 **미등록(Unlisted)** — 링크를 아는 사람만 설치, 검색 노출 없음
4. 권한 사유를 한 줄씩 적는다. 대충 쓰면 반려된다:
   - `scripting` — 타임인아웃 페이지에서 본인 휴가 내역을 읽기 위해
   - `tabs` — 조회용 백그라운드 탭을 열고 닫기 위해
   - `storage` — 사용자가 선택한 조회 연도 저장
   - `user.timeinout.kr` — 유일한 데이터 출처
5. 심사 1~3일 → 링크 발급

### 제출 자동화

- 출퇴근 정정 — 조회 결과의 제안값을 확인한 뒤 타임인아웃 `수정 요청`으로 날짜별 제출
- 야근택시 — 인정 건을 묶고 타임인아웃 근태 증빙 PNG를 첨부해 `야근교통비` 결재 1건으로 상신
- 야근식비 — 인정 건을 묶어 `야근식비` 결재 1건으로 상신

세 기능 모두 결과 조회만으로는 외부 시스템을 쓰지 않는다. `대상 확인`과 `실제 제출`의
두 번 확인을 통과해야만 쓰기 메시지를 보내며, e2e도 확인 전 요청이 0건인지 검증한다.
상태 기반 웹앱 탭 재사용 원칙과 팝업 처리 배경은 `docs/browser-automation.md` 참고.
