"""Rank LinkedIn jobs (jobs.json) against the resume text extracted from PDF.

jobs.json only carries title/company/location/url, so scoring is keyword-weighted
on the title plus location fit. Run with --fetch to pull descriptions first.
"""

import json
import re
import sys
from pathlib import Path

# Windows consoles default to cp1252 and blow up on the rupee sign in the data.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

JOBS = Path(r"C:\muttu\LinkedInScraping\basic-scrapy-project\jobs.json")
RESUME = Path(__file__).parent / "resume_extracted.txt"

# Weighted skill groups derived from the resume's core competencies + experience.
STRONG = {
    "mlops": 10, "machine learning": 6, "ml engineer": 8, "ai engineer": 8,
    "ai/ml": 8, "llm": 7, "genai": 7, "gen ai": 7, "generative ai": 7,
    "rag": 7, "agentic": 7, "ai architect": 10, "ai platform": 8,
    "kubernetes": 7, "docker": 5, "mlflow": 6, "dvc": 5, "zenml": 6,
    "aws": 5, "azure": 5, "gcp": 4, "terraform": 5, "cicd": 6, "ci/cd": 6,
    "python": 5, "fastapi": 5, "pytorch": 4, "tensorflow": 4,
    "sagemaker": 5, "eks": 5, "data engineer": 3, "devops": 4,
    "cloud": 3, "nlp": 4, "computer vision": 3, "azure ai": 7,
    "data scientist": 3, "analytics": 2, "automation": 3, "microservices": 3,
}
WEAK = {
    "java": 2, "sap": 1, "salesforce": 1, "marketing": 0, "recruiter": 0,
    "customer support": 0, "telesales": 0, "accountant": 0, "nurse": 0,
    "teacher": 0, "driver": 0, "store": 0, "hr ": 0, "business development": 0,
    "inside sales": 0, "bpo": 0, "medical": 0, "pharma": 0, "banking": 0,
    "insurance": 0, "real estate": 0, "workday": 0, "maintenance": 0,
}
SENIORITY = {
    "senior": 3, "staff": 4, "principal": 4, "lead": 3, "architect": 5,
    "manager": 3, "director": 4, "head of": 4, "jr": -3, "junior": -3,
    "trainee": -5, "intern": -6, "entry level": -3, "fresher": -5,
    "associate": -1, "trainee": -5,
}
REMOTE = {"remote": 4, "hybrid": 3, "wfh": 3, "work from home": 4}


def norm(s):
    return re.sub(r"\s+", " ", (s or "")).lower()


def score(job):
    text = norm(f"{job.get('job_title','')} {job.get('company_name','')} "
                f"{job.get('job_detail_url','')}")
    s, hits = 0, []
    for k, w in STRONG.items():
        if k in text:
            s += w
            hits.append(k)
    for k, w in WEAK.items():
        if k in text:
            s -= w
    for k, w in SENIORITY.items():
        if k in text:
            s += w
    for k, w in REMOTE.items():
        if k in text:
            s += w
    loc = norm(job.get("company_location", ""))
    if any(c in loc for c in ("bengaluru", "bangalore")):
        s += 4
    elif any(c in loc for c in ("india", "hyderabad", "pune", "chennai",
                                "mumbai", "delhi", "ncr", "gurgaon")):
        s += 1
    return s, hits


def main():
    jobs = json.loads(JOBS.read_text(encoding="utf-8"))
    resume = RESUME.read_text(encoding="utf-8").lower()
    # Terms in the resume that are absent from a job title are just noise, but
    # sanity-check that the resume text is what we think it is.
    for probe in ("kubernetes", "mlops", "fastapi", "terraform", "rag"):
        assert probe in resume, f"resume missing {probe}"

    ranked = []
    for j in jobs:
        s, hits = score(j)
        ranked.append({**j, "score": s, "hits": hits})
    ranked.sort(key=lambda x: -x["score"])

    out = Path(__file__).parent / "ranked_jobs.json"
    out.write_text(json.dumps(ranked, indent=1, ensure_ascii=False), encoding="utf-8")

    print(f"{len(jobs)} jobs scored -> {out}\n")
    for i, j in enumerate(ranked[:25], 1):
        print(f"{i:2}. [{j['score']:3}] {j['job_title']} | {j['company_name']} "
              f"| {j['company_location']}")
        print(f"     {j['job_detail_url'][:110]}")
        print(f"     hits: {', '.join(j['hits'][:8])}")


if __name__ == "__main__":
    sys.exit(main())
