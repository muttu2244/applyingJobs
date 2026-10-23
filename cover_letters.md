# Tailored Application Drafts — Top 5 Matches

Generated from [Shivayogi_From_15082026.pdf](C:/muttu/Shivayogi_From_15082026.pdf) matched against the
live job descriptions on LinkedIn. LinkedIn "Easy Apply" typically only collects a resume + a short
note, so these are written as concise cover letters (150–250 words).

**Gaps to be aware of, from reading the actual postings:**

| # | Job | Notes |
|---|-----|-------|
| 1 | Infosys | Strongest fit. Wants LangGraph/LangChain + Bedrock + RAG + SageMaker — all present. |
| 2 | UST | Excellent fit. Wants agentic AI, LangChain/AutoGen, RAG, Azure DevOps, Terraform, Prometheus/Grafana, governance. Posting names a contact email (nitin.patil@ust.com) and asks for immediate joiners. |
| 3 | Mavenir | **Requires strong C and C++.** This is the one genuine gap in your profile. The role is also scoped at "3–4 years hands-on AI/ML", well under your 20+. Voice AI (STT/TTS/voice agents) is also not on your resume. Recommend low priority. |
| 4 | TrueFoundry | Very strong fit. Agent orchestration with graph/stateful workflows, LangGraph, MCP, guardrails, policy enforcement. Maps almost 1:1 onto your 6-agent LangGraph/AutoGen work with Application Insights tracing. |
| 5 | TCS | Good fit on GenAI/RAG/observability, but scoped at "6 to 10 years". Expect a notice-period conversation — you have been out since Dec 2025. |

---

## 1. AI/ML Engineer (Generative AI, ML, AWS) — Infosys

Subject line if the form allows one: GenAI/ML Engineer — RAG, Agentic AI & MLOps

> I'm applying for the AI/ML Engineer (Generative AI, ML, AWS) role in Bengaluru. My work sits
> almost exactly where this position is pointed.
>
> At Streamline Healthcare I architected a production AI platform on Python and FastAPI that turns
> raw engineering data into ranked, actionable risk intelligence. That meant building an
> XGBoost-based predictive scoring pipeline, a RAG-style assistant with grounded Q&A over uploaded
> documents, and a framework-agnostic agentic orchestration layer that deliberately avoids
> LangChain scaffolding so the control flow stays inspectable.
>
> Before that, at Kyndryl, I built a multi-agent AI compliance system monitoring 50+ AWS accounts
> that cut false positives from 34% to 2% and remediation time from 8.3 days to 2.1 hours — about
> $1.2M annually. I also ran end-to-end MLOps pipelines with Terraform, ZenML, and Kubernetes across
> Dev/QA/Prod, and shipped BERT-based ticket classification above 90% accuracy behind a FastAPI
> service with Prometheus and Grafana.
>
> Your requirements around RAG architectures, embeddings, vector databases, LangGraph-style
> orchestration, and SageMaker/Bedrock integration map directly onto work I've already put into
> production. I'm comfortable owning ML pipelines end to end, from model design through deployment
> and monitoring.

---

## 2. Senior AI/ML DevOps Platform & SDLC Automation Architect — UST

Subject line: AI/ML Platform & Automation Architect — 20+ yrs

> I'm writing to apply for the Senior AI/ML DevOps Platform & SDLC Automation Architect role. The
> posting asks for 12+ years across software engineering, architecture, DevOps, and platform
> engineering, with agentic AI and multi-step workflow automation — I've built a career in exactly
> that intersection.
>
> My current role as AI Architect at Streamline Healthcare is largely this brief. I architected a
> six-agent autonomous modernization pipeline on Azure AI Foundry, using LangGraph and AutoGen with
> explicit state transitions, retry and fallback loops, and checkpointing so failed stages resume
> without full re-runs. It converted .NET 4.8 to .NET Core 8 across 275 modules in under three days
> versus an eight-to-twelve-week manual baseline.
>
> Several items here I want to flag as directly relevant rather than adjacent. On observability, I
> instrumented every agent with Application Insights for per-agent latency, token usage, and failure
> points. On governance, I built a zero-trust PHI sanitization gate (Presidio plus deterministic
> SHA-256 masking) applied before and after every LLM call, which was verified through automated
> evals to produce zero PHI exposure to external models. On CI/CD, the platform runs containerized
> on Azure Container Apps via Azure DevOps with zero-downtime rolling deploys. I've also built
> prompts, embeddings, and RAG retrieval over Azure AI Search, and used FastAPI heavily for
> service-based APIs.
>
> I notice this requisition is open to immediate joiners. I would welcome a conversation about
> timing.

---

## 3. Senior AI Engineer, GenAI / AI Platform / Voice AI — Mavenir

Subject line: Senior AI Engineer — GenAI, AI Platform & MLOps

> I'm applying for the Senior AI Engineer role in Bengaluru. Most of the GenAI, AI platform, and
> MLOps scope here matches work I've shipped in production, so I'll lead with that.
>
> At Streamline Healthcare I designed and productionized an AI platform end to end — problem
> definition, architecture, model and pipeline development, deployment, and observability. Recent
> work has been dominated by LLM systems: a six-agent orchestration graph on Azure AI Foundry, RAG
> with Azure AI Search-grounded retrieval over real legacy codebases, an automated eval harness
> scoring generated code on compile success and test-pass rate, and a zero-trust sanitization layer
> governing every model call. Earlier at Kyndryl I built MLOps pipelines on Terraform, ZenML, and
> Kubernetes, and an NLP service that reduced ticket resolution time by 40%.
>
> I want to be straightforward about two areas. My production language depth is Python — FastAPI,
> Flask, Django — and my core AI/ML work has been in Python, not C or C++; Java appears earlier in
> my career but not in the systems I've led most recently. And I haven't built speech-to-text,
> text-to-speech, or real-time voice agent systems. If the C/C++ and Voice AI work is genuinely
> core to this role rather than adjacent, that's a real gap on my side and I'd rather say so than
> overstate it.
>
> On the AI gateway and governed-platform portion, and on ML training and evaluation workflows,
> I'd be able to contribute meaningfully from day one.

---

## 4. Senior AI/ML Engineer: LLM & Agent Stack — TrueFoundry

Subject line: Senior AI/ML Engineer, LLM & Agent Stack — agent orchestration & governance

> I'm applying for the Senior AI/ML Engineer role on the LLM and Agent Stack. Your framing of the
> problem — that companies are moving past simple chatbots to production agentic systems, and that
> the infrastructure to support them properly doesn't yet exist — is a description of the last
> eighteen months of my work.
>
> At Streamline Healthcare I designed a six-agent orchestration graph on Azure AI Foundry with
> explicit state transitions, deterministic control loops governing agent handoffs, retry and
> fallback paths, and checkpointing that resumes failed stages without full re-runs. Building it
> taught me most of what your role calls for: why a Duct-Taped set of API calls isn't production
> software. Context discipline was the hard problem. I built per-agent context pipelines so each
> agent's working set stayed minimal, relevant, and token-efficient across long-running tasks.
> Retrieval grounding came next, via Azure AI Search over the actual legacy codebase, which
> measurably reduced hallucinated logic in generated code. Then governance: a zero-trust PHI
> sanitization gate with pre- and post-call masking on every LLM interaction, Entra ID RBAC, Key
> Vault, and APIM in front of the platform.
>
> Observability was non-negotiable. Every agent call was instrumented through Application Insights
> for per-agent latency, token usage, and failure points, and I built an automated eval harness that
> scores generated code on compile success, test-pass rate, and coverage *before* anything reaches
> human review — the same guardrail-first posture your AI Gateway is built around.
>
> I'm comfortable designing graph-based and stateful orchestration, integrating upstream tooling
> like LangGraph and LangChain, and reasoning about routing, policy enforcement, and cost controls.
> I'd like to talk about the AI Gateway components in detail.

---

## 5. Site Reliability Engineer, Python & GenAI Platforms — TCS

Subject line: SRE — Python, GenAI platforms & Kubernetes

> I'm applying for the Site Reliability Engineer role in Bangalore. The GenAI-in-production and
> observability requirements are the parts of my background I'd most want to bring to this team.
>
> I've supported LLM-based applications in production, including the failure modes you call out. A
> zero-trust PHI sanitization gate guards every model call pre- and post-invocation in one of my
> current systems, specifically to control hallucination and data-residue risk. I instrumented the
> full pipeline through Application Insights for per-agent latency, token usage, and failure points,
> and built automated eval harnesses that gate generated output before human review. Separately, I
> architected a multi-agent compliance system at Kyndryl monitoring 50+ AWS accounts that cut false
> positives from 34% to 2% and remediation time from 8.3 days to 2.1 hours, saving roughly $1.2M
> annually — that work was fundamentally about reducing alert noise and accelerating response.
>
> On platform and automation: I've built and run MLOps pipelines on Terraform, ZenML, and Kubernetes
> across Dev/QA/Prod, shipped containerized applications on AWS EKS with auto-scaling via GitHub
> Actions, and processed 15M+ compliance signals daily through Kafka and PostgreSQL with full
> audit trails. Monitoring practice includes Prometheus and Grafana on a FastAPI service carrying
> BERT-based ticket classification above 90% accuracy.
>
> I see the role's 6–10 year band as a comfortable fit from the platform side, and I should flag
> that my availability is not immediate — my last role concluded in December 2025. I'd be glad to
> discuss notice timing directly.

---

## Suggested answers to common screening questions

- **Total experience:** 20+ years
- **Current title:** AI Architect (from March 2026); previously Senior Lead – AI/ML at Kyndryl (Oct 2020 – Dec 2025)
- **Notice period / availability:** open to discuss, not immediate — honest framing matters more than a fast yes
- **Work location:** Bangalore, India
- **AI/ML-specific years:** ~2 focused years post-upskilling, on top of 20 years of engineering; the IISc AI/ML Ops certification (2024) supports this
- **Notice period detail:** most recent employment ended Dec 2025
