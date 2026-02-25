# OutcomeEscrow Architecture

## 1. Phase 0 MVP (검증기 포함 로컬 실행)

```mermaid
flowchart LR
    B[Buyer App]
    O[Operator App]
    API[OutcomeEscrow API]
    META[(Meta Store)]
    OBJ[(Artifact Storage)]
    MCP[MCP Runtime]
    TOOLS[External MCP Tools]
    CHAIN[Solana Escrow Program]
    USDC[(USDC Vault PDA)]
    OPS[Ops Console]

    B -->|create job / fund escrow| API
    API --> META
    API --> CHAIN
    CHAIN --> USDC

    O -->|run workflow| MCP
    MCP --> TOOLS
    O -->|submit result| API
    API --> OBJ
    API --> META

    B -->|approve or reject| API
    API --> CHAIN

    B -->|open dispute| API
    API --> OPS
    OPS -->|manual decision| API
    API --> CHAIN
```

핵심:
- 승인/거절 권한: Buyer
- 분쟁 최종 결정: Ops
- 결과물 저장: 현재 텍스트 기반(추후 파일 업로드 확장 예정)

## 2. 플로우

### 2.1 정상 정산

```mermaid
sequenceDiagram
    participant Buyer
    participant Operator
    participant API
    participant Chain

    Buyer->>API: CreateJob(serviceId)
    API->>Chain: create_job + fund_job
    Operator->>API: SubmitResult(job_id, submission)
    Buyer->>API: Review(job_id, approve=true)
    API->>Chain: review_job(approve)
```

### 2.2 분쟁 처리

```mermaid
sequenceDiagram
    participant Buyer
    participant Operator
    participant API
    participant Ops
    participant Chain

    Operator->>API: SubmitResult(job_id, submission)
    Buyer->>API: Review(job_id, approve=false)
    API->>Ops: OpenDispute(job_id)
    Ops->>API: Resolve(payout)
    API->>Chain: resolve_dispute
```

## 3. 데이터 모델 (MVP 최소)

- Job
  - `job_id`, `buyer`, `operator`, `reward`, `deadline`, `status`
- Submission
  - `job_id`, `submission_text` (추후 파일/URI 확장)
- Review
  - `job_id`, `buyer_decision`, `decided_at`
- Dispute
  - `job_id`, `ops_decision`, `payout`

## 4. 확장 포인트

- MCP가 직접 결과물을 업로드하는 흐름
- 제출물 파일 저장(S3/MinIO/로컬) + 다운로드 링크
- 다자간 분쟁 판정/중재
