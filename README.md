# chat-mcp

Codex에서 Chrome의 ChatGPT 계정으로 코드 리뷰, 설계 비교, 디버깅 분석을 요청하는 로컬 플러그인입니다.

## 처음 설치하기

**준비물:** Codex 앱, Node.js 22 이상(npm 포함), Git, Chrome 116 이상, ChatGPT 계정.

### 1. 터미널에서 설치

Windows는 PowerShell, macOS/Linux는 터미널에서 아래 명령을 차례로 실행하세요.

```sh
git clone https://github.com/phykn/chat-mcp.git
cd chat-mcp
npm run setup
```

`npm run setup`이 의존성 설치 → 빌드 → Codex 플러그인 등록·설치 → Chrome 연결 확인까지 안내합니다. **Codex에서 마켓플레이스를 먼저 추가할 필요는 없습니다.** Codex CLI가 없으면 설치 과정에서 자동으로 준비합니다.

### 2. 안내된 폴더로 Chrome 확장 연결

설치가 Chrome 연결 단계에 도달하면 터미널에 **선택할 폴더의 전체 경로**가 표시됩니다. 일반 터미널에서는 Chrome 확장 관리 화면과 해당 폴더도 자동으로 엽니다. 열리지 않으면 Chrome 주소창에 `chrome://extensions`를 입력하세요.

1. 오른쪽 위 **개발자 모드**를 켭니다.
2. **압축해제된 확장 프로그램 로드**를 누릅니다.
3. 터미널에 표시된 경로를 폴더 선택 창에 붙여 넣고 **폴더 선택**을 누릅니다. Windows에서는 주소창에, macOS에서는 **⌘⇧G**로 여는 ‘폴더로 이동’에 붙여 넣으세요.
4. 자동으로 열린 ChatGPT 탭에서 로그인합니다. 모드 선택 화면이 나오면 **Chat**을 선택합니다.
5. 터미널로 돌아와 **Enter**를 눌러 연결을 확인합니다. 추가 안내가 나오면 처리한 뒤 다시 Enter를 누르세요.

기본 확장 폴더는 아래와 같습니다. 환경설정을 바꿨다면 터미널에 표시된 경로를 따르세요.

| 운영체제 | Chrome에서 선택할 폴더 |
| --- | --- |
| Windows | `C:\Users\내사용자이름\.chat-mcp\extension` |
| macOS | `/Users/내사용자이름/.chat-mcp/extension` |
| Linux | `/home/내사용자이름/.chat-mcp/extension` |

**위 경로의 폴더 전체를 선택하세요.** 내려받은 저장소의 `extension` 폴더에는 설치 중 생성되는 설정 파일이 없습니다. `manifest.json` 파일을 열거나 내용을 복사할 필요도 없습니다.

`[사용 준비 완료]`가 나오면 MCP 서버 실행과 ChatGPT 연결 확인까지 끝난 것입니다. 나중에 연결하려면 `q`로 종료하고, 준비됐을 때 저장소 폴더에서 `npm run doctor`를 실행하세요.

### 3. 새 Codex 작업에서 사용

설치 전에 열어 둔 작업에는 도구가 반영되지 않을 수 있으니 **새 Codex 작업**을 열고 먼저 확인하세요.

> Chat MCP 연결 상태 확인해줘.

연결이 확인되면 원하는 작업을 요청하세요.

> Chat MCP로 현재 변경사항을 리뷰해줘.

> Chat MCP로 이 두 설계의 장단점을 비교해줘.

## 평소 사용

- Chrome에서 연결된 ChatGPT 탭을 열어 두고 Codex에 요청하면 됩니다. 브리지는 필요할 때 자동으로 시작합니다.
- 매번 설치하거나 확장을 다시 로드할 필요는 없습니다. Chrome을 다시 열면 자동으로 재연결됩니다.
- 연결된 탭을 닫았다면 Chrome의 Chat MCP 확장 아이콘에서 **Open ChatGPT**를 누르세요.
- 요청 중에는 Chrome을 보이는 상태로 두고 PC의 잠금·절전을 피하세요. 응답을 기다릴 때 Chat MCP가 연결된 탭을 선택합니다.

## 업데이트

처음 내려받은 `chat-mcp` 폴더에서 실행하세요.

```sh
git pull --ff-only
npm run setup
```

기존 연결 설정을 유지하면서 플러그인과 확장을 갱신합니다. 연결된 확장은 자동으로 업데이트됩니다. 완료 후 **새 Codex 작업**을 여세요.

## 문제가 생기면

먼저 저장소 폴더에서 아래 명령을 실행하세요. 플러그인 활성화, 확장 파일, MCP 실행, ChatGPT 연결을 확인하고 다음 조치를 알려줍니다. 대화 전송이나 코드 리뷰를 요청하지 않습니다.

```sh
npm run doctor
```

| 증상 | 해결 방법 |
| --- | --- |
| `npm` 또는 `git` 명령을 찾지 못함 | Node.js 22 이상 또는 Git을 설치하고 터미널을 다시 여세요. |
| PowerShell에서 `npm.ps1` 실행이 차단됨 | `npm` 대신 `npm.cmd`를 사용하세요. 예: `npm.cmd run setup`. |
| 확장 로드 실패 / `config.js`·`content.js`를 찾지 못함 | `npm run setup`을 완료한 뒤 **출력된 확장 폴더**를 선택하세요. 저장소의 `extension` 폴더와 다릅니다. |
| 확장이 연결 대기 중 | Chrome 확장 아이콘 → **Open ChatGPT** → 로그인 후 `npm run doctor`. |
| ChatGPT 연결은 됐지만 사용 준비가 안 됨 | 진단 안내에 따라 로그인·Chat 모드·작성 중인 입력·진행 중인 요청을 확인하세요. |
| Codex에서 도구가 보이지 않음 | 설치 후 새 작업을 열고 Chat MCP가 활성화되어 있는지 확인하세요. |

### 이미 GitHub 마켓플레이스를 추가했다면

등록만으로는 실행 파일이나 Chrome 확장이 준비되지 않습니다. 위 **처음 설치하기**의 `npm run setup`부터 진행하세요. 별도로 GitHub판 Chat MCP까지 설치했다면 중복 실행을 피하도록 Codex에서 setup이 출력한 로컬 플러그인(기본값: `chat-mcp@personal`)만 활성화하세요.

마켓플레이스 등록이 필요한 경우 소스는 `https://github.com/phykn/chat-mcp`, Git ref는 `main`, **Sparse paths는 빈칸**입니다. 카탈로그는 `.agents/plugins/marketplace.json`이며 `plugins/codex` 폴더는 없습니다. [마켓플레이스 형식 안내](https://developers.openai.com/plugins/build/plugins#marketplace-metadata).

자동화 환경에서 설치만 준비하려면 `npm run setup -- --non-interactive`를 사용하세요. 화면을 열거나 입력을 기다리지 않으며, 연결이 남아 있으면 진단 안내를 출력합니다. 준비 상태의 종료 코드는 `npm run doctor`로 확인하세요(준비 완료 `0`, 확인 필요 `1`).

## Usage notice

For individual development workflows, not bulk collection or multi-user service hosting. This project is not affiliated with OpenAI.

Browser automation may conflict with service terms and lead to account restrictions or suspension. You are responsible for complying with applicable [terms and policies](https://openai.com/policies/), including for personal use.

Selected code, diffs, and prompts are sent to ChatGPT. Only share content you are authorized to disclose; exclude credentials and confidential information.

## License

[MIT](LICENSE). Provided without warranty; see the license for limitations of liability.
