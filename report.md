# Chat MCP 실패 및 복구 기록

작성일: 2026-09-23 (Asia/Seoul)

## 범위와 최종 결과

Windows의 Codex에서 `C:\code\diffusion-gan3d` 리팩토링을 검토하며 관찰한 내역이다. 사용 플러그인은 `chat-mcp` 버전 `0.1.0+codex.20260923012858`, 연결 대상은 Chrome의 ChatGPT 탭이었다. 이 문서는 대화에 반환된 도구 결과와 화면 확인을 정리한 것이며, 서버 내부 로그를 조사한 원인 분석은 아니다.

초기 health 확인과 간단한 덧셈 질의는 성공했다. 이후 여러 코드 리뷰도 완료됐지만, 전송 후 시간 초과·화면 비표시·복구/취소 실패가 반복됐다. 마지막 source 리뷰는 기존 요청 ID와 동일한 입력으로 재시도해 정상 완료했고, 지적 사항을 로컬에서 검증·수정했다. 최종적으로 이 작업에서 기다려야 할 진행 중 리뷰는 남지 않았다.

## 관찰된 문제

| 현상 | 관찰 근거 | 영향 / 처리 |
| --- | --- | --- |
| 큰 컨텍스트 거부 | `CONTEXT_TOO_LARGE`. 약 65 KB trainer 파일을 포함한 요청과 약 51 KB 타일링 컨텍스트가 거부됐다. | 전송 범위를 책임별로 나누고 파일 수를 줄여 진행했다. 수치는 당시 관찰치이며 고정된 서버 한계로 단정하지 않는다. |
| 전송 뒤 답변 회수 실패 | `timed_out_after_send`, `PAGE_HIDDEN`. 오류는 ChatGPT 화면을 표시하고 같은 ID로 `chatgpt_result`를 호출하도록 안내했다. | 답변이 실제로 생성 중인지, 완료됐지만 수집만 실패했는지 즉시 구분하기 어려웠다. 재전송 대신 원래 ID로 복구했다. |
| 취소도 시간 초과 | 타일링 요청의 `chatgpt_cancel`이 `BRIDGE_TIMEOUT`을 반환했다. | 그 시점에는 취소 성공으로 판단하지 않았다. 이후 같은 요청의 결과 조회에서 `cancelled`와 답변을 확인했다. |
| 취소 결과에 불완전한 답변 포함 | source 요청 취소가 `cancelled`와 `answer: "실제 actionable"`만 반환했다. | 취소 성공과 리뷰 완료를 구분해야 한다. 이 조각을 검토 결과로 인정하지 않았다. |
| 취소된 대화 핸들 후속 요청 거부 | `INVALID_HANDLE`: `No completed managed conversation for this handle.` | 완료된 대화만 후속 요청에 사용할 수 있었다. 해당 호출은 검토 전송 성공으로 기록하지 않았다. |
| 브리지 실패 후 요청 조회 불가 | `BRIDGE_UNAVAILABLE` 이후 같은 ID의 `chatgpt_result`가 `NOT_FOUND`를 반환했다. | 오류 메시지는 명령 수행 여부가 불확실하다고 했지만 조회할 요청 레코드는 없었다. 실행 중 작업이 있다고 가정하지 않았다. 이후 같은 ID·동일 입력의 재시도는 성공했다. |
| working-tree 검토의 파일 포함 범위 | ignored 로컬 비교 스냅샷 및 일부 `run` 경로가 working-tree 검토의 파일 목록에 포함되지 않았다. | 전달 목록에 없는 파일을 검토한 것으로 취급하지 않았다. 필요한 source 파일은 `chatgpt_ask`의 `context_paths`로 전달했다. |

## 요청별 추적

### 학습 실행 리뷰

- 요청: `refactor-run-1790151601121`
- 대화 핸들: `2b15c911-e7ae-4e94-ab99-fa1ccacc8fe6`
- 초기 대기 한도를 넘겼고 결과 복구가 원활하지 않았다. 취소 과정에서 답변을 회수했으며 사용자가 같은 리뷰 내용을 별도로 전달했다.
- 초기 bank source 해시 검증 및 설정 로더 차이 등의 지적을 로컬에서 확인했다.

### 손실 추출 후 리뷰

- 요청: `refactor-loss-review-1790152666268`
- 초기 호출은 시간 초과됐지만 `chatgpt_result`에서 완료된 답변을 회수했다.
- 전달된 objective/GAN helper/batch/test 범위에서 actionable 지적은 없었다. ignored 원본 비교 스냅샷까지 외부 검토된 것은 아니며, 전후 수치 비교는 별도로 로컬에서 수행했다.

### 타일링 리뷰

- 요청: `refactor-tiling-review-1790153533384`
- 대화 핸들: `31e6cf08-07be-45b4-9d8a-956a0b8af93d`
- 전송 후 약 300초 대기 끝에 `PAGE_HIDDEN`; 같은 요청의 결과 조회도 실패했다.
- 취소는 `BRIDGE_TIMEOUT`으로 끝나 상태가 불명확했다.
- 사용자가 답변을 전달했고, 이후 같은 ID의 조회에서 `status: cancelled`와 해당 답변을 확인했다. 이 확인 전에는 새 요청으로 같은 리뷰를 중복 전송하지 않았다.

### source 최종 리뷰 첫 시도

- 요청: `refactor-source-final-1790154261468`
- 대화 핸들: `2f5e03e0-5987-4308-a337-3d5fb903a283`
- 최초 결과: `timed_out_after_send`, `PAGE_HIDDEN`, `elapsed_ms: 300709`.
- 복구 조회: 동일 오류, `elapsed_ms: 334475`.
- 취소: `cancelled`, `elapsed_ms: 346657`; 답변은 `실제 actionable`이라는 불완전한 조각이었다.
- 따라서 이 요청 자체는 최종 리뷰 완료의 근거가 되지 않는다.

### HTTP/UI 리뷰 — 성공 비교 사례

- 요청: `refactor-http-ui-1790154661035`
- 대화 핸들: `b5b8d8a8-f484-4700-8450-012f3a68bc49`
- `completed`, `elapsed_ms: 227920`으로 정상 회수됐다.
- 진행 중 브라우저 접근성 상태에서도 답변 생성과 중지 버튼이 확인됐다. 화면 확인이 복구의 직접 원인이었는지는 입증되지 않았다.

### source 재검토와 최종 복구

1. `refactor-source-recheck-1790154972759`에서 위 취소된 핸들을 재사용했으나 `INVALID_HANDLE`이 반환됐다.
2. `refactor-source-final2-1790154981371` 새 호출은 약 30초 뒤 `BRIDGE_UNAVAILABLE`을 반환했다. 같은 ID 조회는 `NOT_FOUND`였다.
3. 다음 작업 턴에서 같은 ID를 다시 조회했으며 여전히 `NOT_FOUND`였다. 그 뒤 **동일 요청 ID와 동일한 prompt/repo_path/context_paths**로 호출했다.
4. 브라우저 접근성 상태에서 완성된 세 가지 지적과 응답 작업 버튼을 확인했다. 원래 도구 호출도 `completed`, `elapsed_ms: 187426`으로 종료됐다.
5. 최종 대화 핸들은 `f7293668-19ea-460d-a553-0dd6c630530d`였다. 재개 시 source 검증 누락과 bank provenance 문제는 수정했고, 같은 run 디렉터리 충돌 지적은 실제 새 디렉터리 생성 계약을 근거로 채택하지 않았다.

최종 성공 요청의 컨텍스트:

```text
src/train/run/source.py
src/train/run/bank.py
src/train/run/sr.py
src/build/predict.py
tests/train/test_bank_source.py
```

## 개선 제안 — 아직 구현·검증하지 않음

1. 전송 여부, worker 실행 여부, 답변 생성 완료 여부, 수집 실패를 별도 상태로 반환한다. 관찰 시간 초과가 작업 종료로 오해되지 않게 한다.
2. 브라우저 명령 전 요청 ID와 상태를 기록해 `BRIDGE_UNAVAILABLE` 뒤에도 결과 조회나 안전한 재시도가 가능하게 한다. `NOT_FOUND`만으로 전송되지 않았음을 단정할 수 있는지도 명시한다.
3. 취소 응답에 `answer_complete` 또는 partial 표시를 추가한다. `cancelled`에 담긴 조각을 정상 리뷰로 오인하지 않도록 한다.
4. 취소·실패한 conversation handle의 재사용 가능 여부와 대체 복구 방법을 반환한다.
5. 전송 전에 컨텍스트 바이트 수와 포함·제외 파일 목록/사유를 보여준다. ignored 경로가 조용히 빠지는 경우를 구분한다.
6. 화면이 숨겨진 상태, 답변은 완료됐지만 수집이 늦은 상태, 브리지 단절, 취소 응답 유실을 대상으로 통합 테스트를 추가한다. 동일 ID 재시도가 중복 메시지를 만들지 않는지도 확인한다.

이번 작업에서는 요청을 직렬로 실행했고, 불확실한 전송은 원래 ID로 조회했다. 사용자에게 ChatGPT 탭을 표시해 달라고 요청했지만 그 조치가 수행됐다는 응답은 받지 못했다. 화면 잠금이나 탭 비표시가 모든 실패의 근본 원인이었다고 단정할 근거는 없다.
