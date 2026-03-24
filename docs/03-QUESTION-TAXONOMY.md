# Question Taxonomy & Classification System

This document catalogs the types of questions the system handles, how they're classified, and the variation patterns extracted from the codebase.

---

## Classification Architecture

The system uses a **two-layer classification**:

```
Layer 1: DOMAIN CLASSIFICATION          Layer 2: INTENT CLASSIFICATION
─────────────────────────────           ──────────────────────────────

Is this question answerable           What kind of answer structure
from our documents?                    does this question need?

  ┌─────────────┐                       ┌─────────────┐
  │  In-Domain   │ ── Tier 1 ──►       │   lookup     │
  │  (docs)      │                      │   definition │
  └─────────────┘                       │   summary    │
  ┌─────────────┐                       │   comparison │
  │  Financial   │ ── Tier 2 ──►       │   calculation│
  │  (general)   │                      │   process    │
  └─────────────┘                       │   compliance │
  ┌─────────────┐                       │   unknown    │
  │  Off-Topic   │ ── Tier 3 ──►       └─────────────┘
  │  (reject)    │
  └─────────────┘
```

---

## Domain Tiers

### Tier 1 — In-Domain (Document-Grounded)

**What it is:** Questions answerable from the uploaded PDF documents.

**Trigger keywords:** premium, policy, investment, portfolio, allocation, mutual fund, etf, bond, equity, gic, mer, fee, commission, suitability, kyc, compliance, disclosure, withdrawal, deposit, transfer, redemption, subscription, benchmark, returns, annuity, wealth advantage, great eastern, tpd, terminal illness, welcome bonus, loyalty bonus, premium holiday

**Response behavior:** Full RAG pipeline → retrieve → cite with `[N]` references → page-level citations

**Example questions:**
- "What is the premium for the Wealth Advantage plan?"
- "What are the TPD claim requirements?"
- "Compare Plan A and Plan B fee structures"

---

### Tier 2 — Financial General (Web Fallback)

**What it is:** Finance-related questions that aren't covered in uploaded documents.

**Response behavior:** LLM answers from general knowledge, response prefixed with `[Web]` label. No document citations.

**Example questions:**
- "What is dollar-cost averaging?"
- "How does compound interest work?"
- "What's the current Fed funds rate?"

---

### Tier 3 — Off-Topic (Rejected)

**What it is:** Non-financial questions that fall outside the system's scope.

**Rejection patterns:** super bowl, nba, nfl, epl, mlb, nhl, score, match result, weather, temperature, rain, recipe, cook, restaurant, movie, film, netflix, music, song, celebrity, gossip, travel itinerary, flight status, game walkthrough

**Response behavior:** Returns a scope message without calling the LLM.

---

## Intent Types — The 8 Question Patterns

### 1. Lookup (Basic Retrieval)

**Classification:** Default / catch-all when no specific pattern matches.

**What it is:** Direct fact extraction. Single-fact questions with a specific answer in the documents.

**Trigger:** No specific pattern — this is the fallback intent.

**Response structure:** Direct answer with inline citations.

**Prompt behavior:** Standard citation rules, no special structure.

**Example questions:**
- "What is the premium for Plan A?"
- "What is the interest rate on the GIC?"
- "What is the waiting period for critical illness?"
- "How long is the free-look period?"
- "What is the minimum investment amount?"

**What makes this different from other types:**
- Single fact, single source
- No synthesis needed
- Answer is typically a number, date, or short phrase
- Closest to pure vector retrieval + extraction

---

### 2. Definition (Term Explanation)

**Classification:** Regex patterns — `what is/are`, `define`, `meaning of`, `definition of`, `what does X mean`

**What it is:** Term or concept definition. User wants to understand terminology.

**Specific term triggers:** gic, etf, mer, tpd, ivari, ilp, par, riders, annuity, premium

**Response structure:** Clear definition with context from documents.

**Example questions:**
- "What does MER mean?"
- "Define Total Permanent Disability"
- "What is an ILP?"
- "What are riders in insurance?"
- "Meaning of par fund"

**What makes this different from lookup:**
- Lookup retrieves a specific data point
- Definition retrieves conceptual explanations
- May require synthesizing from multiple mentions across documents

---

### 3. Broad Summary (Synthesis)

**Classification:** Regex — `explain`, `summarise/summarize`, `overview`, `tell me about`, `what is/does this`, `what topics/sections`, `what does this cover`, `describe`

**What it is:** Comprehensive overview of a product, document, or topic. Requires reading across multiple sections and synthesizing.

**Response structure (enforced by prompt):**
1. What is this product/document?
2. Who it's for
3. Key benefits and features
4. Risks and exclusions
5. Fees
6. Flexibility
7. Important notes
8. Source type

**Example questions:**
- "Give me an overview of the Wealth Advantage plan"
- "Explain the Great Eastern Life product"
- "What does this document cover?"
- "Summarize the key features of Plan A"
- "Tell me about the investment options available"
- "Describe the retirement planning product"

**What makes this different from lookup:**
- Requires multi-chunk synthesis (reading many parts of a document)
- Structured answer with multiple sections
- No single "right answer" — quality depends on comprehensiveness
- This is the hardest question type for simple RAG systems

---

### 4. Comparison (Multi-Entity Analysis)

**Classification:** Comparative regex — `compare`, `versus`, `vs`, `difference`, `best`, `better`, `worst`, `higher`, `lower`, `which`, `pros and cons`, `advantages`, `disadvantages`

**What it is:** Side-by-side comparison of two or more products, plans, or options.

**Special retrieval behavior:**
- Match count multiplied 3× (30 instead of 10)
- Page expansion similarity threshold lowered to 0.40 (vs 0.43 standard)
- Round-robin diversification ensures minimum 3 chunks per document
- Forces representation from all compared entities

**Response structure (enforced by prompt):**
1. Options being compared
2. Comparison criteria
3. Evidence for each option
4. Conclusion (only if all options have sufficient data)
5. Caveats (missing data, incomplete coverage)

**Critical rule:** "Do NOT declare a winner if evidence for one or more options is missing."

**Example questions:**
- "Compare Plan A vs Plan B premiums"
- "Which plan is best for a 35-year-old?"
- "What are the differences between the two GIC options?"
- "Pros and cons of whole life vs term life"
- "Is Plan A better than Plan B for retirement?"
- "What are the advantages of endowment over ILP?"

**What makes this different:**
- Must retrieve from multiple documents simultaneously
- Requires balanced evidence (not just the first match)
- The system actively tries to prevent one-sided comparisons
- Most complex retrieval pattern in the system

---

### 5. Calculation (Numeric Reasoning)

**Classification:** Regex — `calculate`, `compute`, `how much`, `total`, `breakeven`, `break-even`, `maximum loan`, `payout comparison`, `premium total`

**What it is:** Questions requiring arithmetic or numeric analysis from document data.

**Response structure (enforced by prompt):**
1. Inputs found (with citations)
2. Formula or method
3. Step-by-step computation
4. Final result

**Critical rule:** "Do NOT estimate or assume a value" if an input is missing.

**Evidence sufficiency:** Special check for missing numeric inputs → `partial_answer` mode.

**Example questions:**
- "How much is the total premium over 10 years?"
- "Calculate the breakeven point for Plan A"
- "What's the maximum loan against my policy?"
- "How much would I pay monthly for $500K coverage?"
- "What is the total payout at age 65?"

**What makes this different:**
- The LLM must do arithmetic in-context (no calculator tool)
- Missing inputs are a common failure mode
- Requires extracting specific numbers from tables
- Most sensitive to table extraction quality

---

### 6. Process (Procedural)

**Classification:** Regex — `how do`, `how can`, `how should`, `steps to`, `procedure for`, `process for`, `how to submit`, `how to apply`, `how to file`, `claim process`, `servicing`

**What it is:** Step-by-step procedural questions about how to do something.

**Response behavior:** Prefers exact wording from documents. Quotes procedural steps directly rather than paraphrasing.

**Example questions:**
- "How do I file a TPD claim?"
- "What is the process for policy surrender?"
- "Steps to apply for a premium holiday"
- "How do I submit a withdrawal request?"
- "What is the claim process for critical illness?"
- "How to transfer my policy to another advisor?"

**What makes this different:**
- Accuracy of exact steps matters more than synthesis
- Direct quotes preferred over paraphrasing
- Sequential order must be preserved
- Often involves regulatory/compliance considerations

---

### 7. Compliance (Regulatory)

**Classification:** Regex — `can I/we say/recommend/suggest`, `regulation`, `MAS guideline`, `advisory constraint`, `suitability requirement`, `restricted activity`

**What it is:** Questions about what advisors can and cannot say or do, regulatory requirements, and compliance boundaries.

**Response behavior:** Same as process — exact wording from documents, direct quotes, no paraphrasing. The system will not advise; it only quotes.

**Example questions:**
- "Can I recommend this product to a retiree?"
- "What are the MAS guidelines for suitability?"
- "What disclosure requirements apply to this product?"
- "Am I allowed to guarantee returns?"
- "What suitability requirements must be met?"
- "Are there restricted activities for this product type?"

**What makes this different:**
- Highest stakes for accuracy — wrong compliance advice is dangerous
- Must quote regulations exactly
- System explicitly avoids giving advice ("don't advise, quote")
- Often involves cross-referencing multiple regulatory documents

---

### 8. Unknown (Ambiguous)

**Classification:** No pattern match, LLM uncertain, or multi-part questions that span categories.

**What it is:** Queries that don't fit clearly into any other category.

**Response behavior:** Generic answer mode with standard citation rules.

**Example scenarios:**
- Multi-part questions: "Tell me about Plan A and how it compares to Plan B, and calculate the 10-year cost"
- Vague queries: "Help me with this"
- Novel question structures not matching any pattern

---

## Question Variation Matrix

This matrix shows how the same underlying information need manifests as different question types:

| Topic: Premium Information | Question Type | Example |
|---|---|---|
| Single fact | Lookup | "What is the annual premium for Plan A?" |
| Concept | Definition | "What does 'regular premium' mean?" |
| Overview | Broad Summary | "Explain the premium structure of Plan A" |
| Side-by-side | Comparison | "Compare premiums of Plan A vs Plan B" |
| Arithmetic | Calculation | "Calculate total premiums over 20 years" |
| How-to | Process | "How do I apply for a premium holiday?" |
| Regulatory | Compliance | "Can I waive the premium payment?" |

---

## Answer Mode vs Intent

The system has **two orthogonal dimensions** that affect response generation:

```
                    Client Mode                    Learner Mode
                    (concise bullets)              (expanded explanations)
                    ─────────────────              ────────────────────────
Lookup              1-2 sentence answer            2-4 sentence answer with context
Definition          Short definition               Definition + implications + examples
Broad Summary       Bullet-point overview          Detailed sections with reasoning
Comparison          Bullet comparisons             Detailed analysis per option
Calculation         Numbers + result               Full walkthrough with reasoning
Process             Numbered steps                 Steps + why each matters
Compliance          Direct quote                   Quote + context + implications
```

---

## Analytics Categories

The admin dashboard groups questions into these operational categories for monitoring:

| Category | Description |
|---|---|
| **KYC & Suitability** | Know-your-client, risk profiling, suitability assessment |
| **Product Features & Eligibility** | Plan details, coverage, eligibility criteria |
| **Portfolio Construction & Allocation** | Asset allocation, diversification, rebalancing |
| **Fees & Compensation** | Fee structures, commissions, expense ratios |
| **Performance & Benchmarks** | Returns, benchmarks, historical performance |
| **Compliance & Disclosure** | Regulatory requirements, disclosures, restrictions |
| **Account Operations & Transactions** | Deposits, withdrawals, transfers, claims |
| **Client Recommendation Wording** | How to phrase recommendations to clients |

---

## Classification Flow Summary

```
User Query
    │
    ▼
┌─────────────────────────────┐
│  HEURISTIC FAST-PATH        │
│                             │
│  33 financial keywords?     │──── Yes ──► Tier 1 (in-domain)
│  Off-topic pattern?         │──── Yes ──► Tier 3 (reject)
│  Intent regex match?        │──── Yes ──► Set intent (0.85 confidence)
│                             │
│  None matched?              │
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐
│  LLM CLASSIFICATION         │
│  (gpt-4o-mini, temp=0)      │
│                             │
│  Returns:                   │
│  • in_domain (bool)         │
│  • is_financial (bool)      │
│  • intent (string)          │
│  • confidence (float)       │
│  • reason (string)          │
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐
│  SAFETY OVERRIDE            │
│                             │
│  Short + ambiguous?         │
│  → Default to in_domain     │
│                             │
│  Heuristic intent exists?   │
│  → Prefer over LLM intent   │
└──────────┬──────────────────┘
           │
           ▼
   Final: { domain_tier, intent }
          Cached for 2 minutes
```
