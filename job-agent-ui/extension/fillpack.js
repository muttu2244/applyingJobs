/* GENERATED FILE — do not edit by hand.
 * Source: ../autofill.json
 * Regenerate: node build-fillpack.js
 */
"use strict";
globalThis.FILLPACK = {
  "_readme": "Agent fill pack. Fields with a value are typed verbatim into application forms. Fields in askUser have null values — the agent must ask, never guess, before filling them. The questions bank answers free-text screening questions by pattern; a null answer means the agent asks you instead of guessing. A question entry may also carry choiceOnly (the answer is one of the option labels, never free text) and fallback (the option to pick when the answer is not offered, e.g. 'Skip this question').",
  "identity": {
    "firstName": "Shivayogi",
    "lastName": "Math",
    "fullName": "SHIVAYOGI MATH",
    "email": "muttu2244@yahoo.com",
    "phone": "+91-9900455663",
    "phoneLocal": "9900455663",
    "city": "Bengaluru",
    "state": "Karnataka",
    "country": "India",
    "address": null,
    "postalCode": null,
    "headline": "AI/ML | MLOps | FullStack",
    "linkedinUrl": null,
    "githubUrl": null,
    "portfolioUrl": null,
    "languages": null,
    "currentEmployer": "Streamline Healthcare",
    "currentTitle": "AI Architect",
    "currentSince": "March 2026",
    "totalExperienceYears": "20+",
    "aiMlExperienceYears": "2 (focused, post-IISc certification) on top of 20 years of engineering",
    "highestEducation": "MCA (Computer Applications), VTU / BMSCE Bangalore, 2003",
    "secondDegree": "PGDBA, Symbiosis Institute Pune, 2012"
  },
  "geolocation": {
    "city": "Bengaluru",
    "lat": 12.9716,
    "lon": 77.5946,
    "accuracy": 1500,
    "_note": "Coordinates answered to sites that ask for your location, so the browser's permission prompt (which is browser UI, not page DOM) never interrupts a run. Edit lat/lon to your exact spot, or delete this block to get the normal prompt back."
  },
  "work": {
    "noticePeriod": "2 Months",
    "earliestStart": "available — discuss directly",
    "workAuthorizedIndia": true,
    "requiresSponsorship": false,
    "requiresSponsorshipNote": "India roles only — fill 'No sponsorship required'",
    "willingToRelocate": "Bangalore only",
    "willingToRelocateNote": "fill 'No relocation — based in Bangalore'",
    "expectedSalary": null,
    "expectedSalaryNote": "user chose to enter an exact figure but has not given it yet — ask for the ₹ LPA number before first fill",
    "currentSalary": null,
    "employmentType": "Full-time",
    "prefersRemote": "hybrid / Bangalore"
  },
  "education": [
    {
      "school": "BMSCE / VTU",
      "degree": "MCA (Computer Applications)",
      "field": "Computer Applications",
      "endYear": "2003",
      "location": "Bangalore"
    },
    {
      "school": "Symbiosis Institute, Pune",
      "degree": "PGDBA",
      "field": "Business Administration",
      "endYear": "2012",
      "location": "Pune"
    }
  ],
  "certifications": [
    "AI/ML Ops Certification — Indian Institute of Science, Bangalore (2024)",
    "Scaled Agile Framework Certified"
  ],
  "employmentHistory": [
    {
      "company": "Streamline Healthcare",
      "title": "AI Architect",
      "start": "March 2026",
      "end": "present",
      "location": "Bangalore"
    },
    {
      "company": "Kyndryl",
      "title": "Senior Lead – AI/ML",
      "start": "Oct 2020",
      "end": "Dec 2025",
      "location": "Bangalore"
    },
    {
      "company": "McAfee",
      "title": "Staff Engineer – Development & Security",
      "start": "Oct 2017",
      "end": "Mar 2020",
      "location": "Bangalore"
    },
    {
      "company": "Wipro",
      "title": "Architect – Healthcare & Development",
      "start": "Sep 2014",
      "end": "Sep 2017",
      "location": "Bangalore"
    },
    {
      "company": "Zynga",
      "title": "Senior Engineer – Platform",
      "start": "Apr 2011",
      "end": "Aug 2014",
      "location": "Bangalore"
    },
    {
      "company": "HP",
      "title": "Senior Engineer – Development & Tools",
      "start": "2007",
      "end": "2011",
      "location": "Bangalore"
    },
    {
      "company": "Mindtree",
      "title": "Senior Engineer – Development",
      "start": "2004",
      "end": "2007",
      "location": "Bangalore"
    }
  ],
  "screening": {
    "totalExperience": "20+ years",
    "whyThisRole": "I'm applying because this work sits in the intersection I've spent the last several years in: production AI/ML systems and the platform engineering around them. At Streamline Healthcare I architected a production AI platform on Python and FastAPI — predictive scoring, RAG-grounded Q&A over uploaded documents, and a framework-agnostic agentic orchestration layer with explicit state transitions, retry and fallback loops, and checkpointing so failed stages resume without full re-runs. At Kyndryl I built a multi-agent AI compliance system monitoring 50+ AWS accounts that cut false positives from 34% to 2% and remediation time from 8.3 days to 2.1 hours, and ran end-to-end MLOps pipelines on Terraform, ZenML and Kubernetes across Dev/QA/Prod. I own ML systems end to end — model design through deployment, monitoring, and evals that gate output before human review. I'd welcome the chance to talk about how any of that maps to your roadmap.",
    "howDidYouHear": "LinkedIn",
    "references": "available on request",
    "eeoDecline": "I decline to self-identify"
  },
  "questions": [
    {
      "match": "form ?16",
      "answer": true,
      "label": "Do you have Form 16 and P/F A/c of current & previous company"
    },
    {
      "match": "notice period",
      "answer": "2 Months",
      "choiceOnly": true,
      "fallback": "Skip this question",
      "label": "What is your notice period?"
    },
    {
      "match": "provident fund|p f a c|pf account",
      "answer": true,
      "label": "PF account of current & previous employer"
    },
    {
      "match": "immediate joiner",
      "answer": false,
      "label": "Can you join immediately"
    },
    {
      "match": "valid passport",
      "answer": false,
      "label": "Do you hold a valid passport"
    },
    {
      "match": "virtual interview|interview if scheduled",
      "answer": true,
      "label": "Availability to attend a virtual interview on the given dates"
    },
    {
      "match": "aadha?r",
      "answer": null,
      "label": "Aadhaar number"
    },
    {
      "match": "\\bpan\\b",
      "answer": null,
      "label": "PAN number"
    }
  ],
  "askUser": [
    {
      "field": "languages",
      "why": "still open: no spoken-language answer on record, and a form refused to advance at 'Select language'"
    },
    {
      "field": "expectedSalary",
      "why": "still open: user chose 'enter exact figure' but the ₹ LPA number was not provided"
    },
    {
      "field": "linkedinUrl",
      "why": "still open: user chose 'paste both URLs' but the URLs were not provided"
    },
    {
      "field": "githubUrl",
      "why": "still open: same — paste with the LinkedIn URL"
    }
  ]
};
