# CredentialDOMD Autonomous System Technical Specification

## For Claude Code: Continuous Launch, Growth, and Self-Optimization

**This document is a living technical specification that defines what the autonomous system does, how it operates, and the order of operations for building and running it. Claude Code should use this as its primary instruction set.**

---

## SYSTEM OVERVIEW

CredentialDOMD operates as an autonomous AI-run company. The system builds itself, markets itself, corrects itself, and fixes itself. The human founder (Eric) provides strategic oversight with minimal involvement (weekly Telegram review + kill switches).

**Core loop:**
```
Monitor → Detect → Decide → Act → Measure → Improve → Repeat
```

**Infrastructure:** Mac Mini M4 (16GB RAM), always on, running all agents locally.

**Notification channel:** Telegram bot for escalation and reporting.

**Revenue model:** Three-tier pricing. Individual (cohort-based, cap $14.99). Practice/Enterprise (flat, 20% under competition). No free tier. 30-day money-back guarantee. Price Lock Guarantee + Most Favored Customer clause.

---

## PHASE 0: BOOTSTRAP (DO THIS FIRST)

These are the foundational tasks that must happen before any agent can run autonomously. Complete them in order.

### 0.1 Environment Setup (Mac Mini)

```bash
# Install core dependencies
brew install python@3.11 node ollama
pip3 install langgraph langchain-anthropic apscheduler aiosqlite python-telegram-bot sentry-sdk

# Install Ollama model for local routing
ollama pull qwen2.5-coder:13b

# Clone the repo (if not already)
cd ~/Projects
git clone <repo-url> CredentialDOMD
cd CredentialDOMD
npm install

# Create the agent workspace
mkdir -p agents/{orchestrator,dev,ops,support,marketing,compliance}
mkdir -p agents/shared/{logs,state,queue}
mkdir -p agents/config
```

### 0.2 Agent State Database

Create `agents/shared/state/agent_state.db` (SQLite):

```sql
-- Task board: all agent work flows through here
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  agent TEXT NOT NULL,           -- 'dev', 'ops', 'support', 'marketing', 'compliance'
  status TEXT DEFAULT 'pending', -- 'pending', 'in_progress', 'completed', 'failed', 'escalated'
  priority INTEGER DEFAULT 5,   -- 1 (critical) to 10 (low)
  title TEXT NOT NULL,
  description TEXT,
  result TEXT,                   -- JSON: what happened
  escalated_to TEXT,             -- 'human' if escalated
  escalation_reason TEXT,
  confidence REAL,               -- 0.0 to 1.0
  tokens_used INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0.0
);

-- Decision log: every agent decision for audit
CREATE TABLE decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  agent TEXT NOT NULL,
  task_id INTEGER REFERENCES tasks(id),
  decision TEXT NOT NULL,
  reasoning TEXT,
  confidence REAL,
  outcome TEXT,                  -- filled after execution
  model_used TEXT,               -- 'claude-sonnet', 'claude-opus', 'ollama-qwen'
  tokens_used INTEGER,
  cost_usd REAL
);

-- Pricing state: tracks signup counts for cohort pricing
CREATE TABLE pricing_state (
  plan TEXT PRIMARY KEY,
  total_signups INTEGER DEFAULT 0,
  current_cohort INTEGER DEFAULT 1,
  current_price REAL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Agent health: circuit breaker state
CREATE TABLE agent_health (
  agent TEXT PRIMARY KEY,
  status TEXT DEFAULT 'active',  -- 'active', 'paused', 'killed'
  failures_1h INTEGER DEFAULT 0,
  last_failure TIMESTAMP,
  daily_cost REAL DEFAULT 0.0,
  daily_budget REAL DEFAULT 50.0,
  last_heartbeat TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Metrics: key business numbers
CREATE TABLE metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  metric_name TEXT NOT NULL,
  metric_value REAL,
  metadata TEXT  -- JSON
);

INSERT INTO pricing_state (plan, total_signups, current_cohort, current_price) VALUES
  ('individual', 0, 1, 4.99),    -- Cohort-based: starts $4.99, cap $14.99
  ('practice', 0, NULL, 119.99), -- Flat: 20% under competition
  ('enterprise', 0, NULL, 429.99); -- Flat: 20% under competition

INSERT INTO agent_health (agent, status, daily_budget) VALUES
  ('orchestrator', 'active', 20.0),
  ('dev', 'active', 50.0),
  ('ops', 'active', 10.0),
  ('support', 'active', 30.0),
  ('marketing', 'active', 30.0),
  ('compliance', 'active', 10.0);
```

### 0.3 Telegram Bot Setup

1. Message @BotFather on Telegram
2. `/newbot` → name it "CredentialDOMD Ops"
3. Save the bot token to `agents/config/.env`:

```
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_CHAT_ID=<your-chat-id>
ANTHROPIC_API_KEY=<key>
SENTRY_DSN=<dsn>
STRIPE_SECRET_KEY=<key>
SUPABASE_URL=<url>
SUPABASE_KEY=<key>
```

### 0.4 Stripe Pricing Configuration

Configure Stripe products and prices matching the pricing engine:

```
Product: CredentialDOMD Physician (COHORT-BASED — price increases every 50 signups)
  - Price (Cohort 1, Monthly): $4.99/mo    ← Founding Member
  - Price (Cohort 1, Annual):  $3.99/mo
  - Price (Cohort 2, Monthly): $6.99/mo    ← Early Adopter
  - Price (Cohort 3, Monthly): $8.99/mo
  - Price (Cohort 4, Monthly): $10.99/mo
  - Price (Cohort 5, Monthly): $12.99/mo
  - Price (Cohort 6, Monthly): $14.99/mo   ← CAP ($5 under MedRenewal $20/mo)
  - Price (Cohort 6, Annual):  $11.99/mo   ← Undercuts Mocingbird $199/yr

Product: CredentialDOMD Practice (FLAT — 20% under competition, no cohorts)
  - Price (Monthly): $119.99/mo   ← Up to 10 providers
  - Price (Annual):  $95.99/mo
  - Benchmark: Market avg ~$150/mo for small group credentialing

Product: CredentialDOMD Enterprise (FLAT — 20% under competition, no cohorts)
  - Price (Monthly): $429.99/mo   ← Unlimited providers
  - Price (Annual):  $322.99/mo
  - Benchmark: Symplr $540/mo entry, Verisys $100-150/provider
```

New Stripe prices for Individual are created automatically when a cohort fills up. Practice and Enterprise prices are fixed. The pricing engine (`src/utils/pricingEngine.js`) handles all of this.

---

## PHASE 1: CORE AGENTS

Build these agents in order. Each agent is a Python module in `agents/<name>/agent.py` using LangGraph.

### 1.1 Orchestrator Agent

**File:** `agents/orchestrator/agent.py`

**Purpose:** Routes tasks between agents, monitors health, escalates to human.

**Runs:** Always (main process, daemon via launchd)

**Responsibilities:**
- Read the task board every 30 seconds
- Route pending tasks to appropriate agents
- Monitor agent health (heartbeats, failure counts)
- Trigger circuit breakers (3 failures/hr = pause agent)
- Send daily Telegram summary report
- Send weekly detailed Telegram report
- Handle human responses from Telegram
- Track daily API spend across all agents

**Escalation triggers (send to Telegram):**
- Agent confidence < 0.6 on any decision
- Any action involving money (Stripe changes, refunds)
- Any user data deletion
- Production deployment of new features
- Agent circuit breaker tripped
- Daily spend > 80% of budget
- Any error the agent can't auto-resolve in 2 attempts

**Circuit breaker rules:**
- 3 failed tasks in 1 hour → pause agent, notify human
- Daily cost exceeds budget → pause agent, notify human
- No heartbeat for 10 minutes → restart agent, notify human
- Human sends `/kill <agent>` → immediately stop agent

### 1.2 Development Agent

**File:** `agents/dev/agent.py`

**Purpose:** Writes code, generates tests, manages CI/CD, fixes bugs.

**Runs:** On task assignment + scheduled (daily dependency check, weekly audit)

**LLM routing:**
- Routing/planning: Ollama (qwen2.5-coder, local, free)
- Code generation: Claude Sonnet 4.5
- Complex architecture decisions: Claude Opus 4.5
- Code review: Claude Sonnet 4.5

**Immediate tasks (do these first to get the product launch-ready):**

1. **Generate test suite**
   - Scan all components in `src/components/`
   - Write Vitest unit tests for each component
   - Write integration tests for critical flows (login, license add, CME track, scan)
   - Target: 80%+ code coverage

2. **Set up CI/CD pipeline**
   - Create `.github/workflows/ci.yml`: lint, test, build on every PR
   - Create `.github/workflows/deploy.yml`: auto-deploy to Netlify on main merge
   - Add Sentry release tracking to deploy pipeline

3. **Build user onboarding flow**
   - First-time user experience: guided setup
   - NPI lookup → auto-populate credentials
   - First document scan walkthrough
   - Compliance ring explanation

4. **Build pricing page component**
   - Uses `src/utils/pricingEngine.js` for dynamic pricing
   - Shows cohort counter (real number, not fake)
   - Displays Price Lock Guarantee and Most Favored Customer clause
   - Urgency messaging from `getUrgencyDisplay()`
   - Stripe Checkout integration

5. **Set up Sentry error tracking**
   - Install `@sentry/react`
   - Configure in `main.jsx`
   - Source maps upload in deploy pipeline

6. **Build the signup/payment flow**
   - Stripe Checkout for plan selection
   - Store locked price in Supabase user metadata
   - Welcome email trigger on successful payment
   - 30-day money-back guarantee logic

**Ongoing tasks (after launch):**
- Auto-fix Sentry errors (read error → trace to source → write fix → create PR)
- Dependency updates (weekly scan, update, test, deploy if green)
- Feature development from task board specs
- Code review on all PRs (including its own, for sanity check)

### 1.3 Operations Agent

**File:** `agents/ops/agent.py`

**Purpose:** Monitors system health, auto-remediates issues.

**Runs:** Every 5 minutes (health checks) + on-demand

**Monitors:**
- Netlify deployment status and response times
- Supabase database health, query performance, row counts
- Stripe webhook delivery and payment success rate
- SSL certificate expiry
- DNS resolution
- API response times (app endpoints)
- Error rates (from Sentry)

**Auto-remediation:**
- Deploy rollback if error rate spikes > 5% after a deployment
- Alert on Supabase approaching row/storage limits
- Alert on unusual traffic patterns (potential abuse)
- Restart services if health checks fail 3x consecutive

**Reporting:**
- Daily: uptime %, error count, response time avg, cost summary → SQLite metrics
- Weekly: full system health report → Telegram

### 1.4 Customer Support Agent

**File:** `agents/support/agent.py`

**Purpose:** Handle inbound support, onboard users, collect feedback.

**Runs:** On new support ticket + scheduled (daily feedback digest)

**Channels:**
- Email support (via support@credentialdomd.com forwarded to agent)
- In-app help widget (future)
- FAQ knowledge base (auto-generated from common questions)

**Resolution flow:**
1. Classify ticket (bug, question, feature request, billing, other)
2. Check knowledge base for matching answer
3. If match found and confidence > 0.8: respond automatically
4. If bug: create GitHub issue, route to Dev Agent
5. If feature request: log to feature request board
6. If billing: route to Stripe (refunds escalate to human)
7. If confidence < 0.6 or anger detected: escalate to human via Telegram

**Target:** 60-80% auto-resolution rate by month 2

### 1.5 Marketing Agent

**File:** `agents/marketing/agent.py`

**Purpose:** Generate content, run campaigns, optimize conversion.

**Runs:** Scheduled (content calendar) + triggered (user lifecycle events)

**Content generation (weekly):**
- 2 blog posts about physician credentialing (SEO-optimized)
- 5 LinkedIn posts targeting physicians and practice managers
- 2 email campaign pieces (onboarding drip, re-engagement)
- 1 case study or testimonial highlight (once we have users)

**Growth loops:**
- SEO: Target long-tail keywords like "CME tracking app", "medical license renewal tracker", "physician credential management software"
- Social: LinkedIn organic (physician networks), physician Facebook groups, Reddit r/medicine
- Email: Drip sequences triggered by user lifecycle (signup, day 3, day 7, day 14, day 30)
- Referral: "Share with a colleague, both get price locked at current rate"

**Conversion optimization:**
- Track landing page → signup conversion
- A/B test pricing page messaging
- A/B test urgency copy variants
- Optimize email subject lines
- Track which content drives signups

**Cohort pricing integration:**
- When a cohort fills (50 users), update pricing page automatically
- Generate "Price just increased" social media post
- Email existing users: "You locked in at $X. New price is $Y. Share with colleagues before it goes up again."

### 1.6 Compliance Agent

**File:** `agents/compliance/agent.py`

**Purpose:** Monitor regulatory compliance, audit data handling, track license changes.

**Runs:** Daily checks + weekly full audit

**Responsibilities:**
- Scan state medical board websites for regulatory changes
- Verify all user data is encrypted at rest (Supabase)
- Audit data access patterns (who accessed what, when)
- Monitor for HIPAA compliance indicators
- Verify backup integrity (Supabase daily backups)
- Check dependency vulnerabilities (npm audit, Snyk)
- Generate compliance reports for enterprise customers

---

## PHASE 2: GROWTH ENGINE

Once agents are running and the product is live, activate the growth loops.

### 2.1 Launch Sequence

1. **Soft launch** (first 50 users): Direct outreach to known physicians. Test all flows. Founding Member pricing ($4.99/mo individual, $119.99/mo practice).

2. **Content launch**: Marketing Agent begins publishing. 2 blog posts/week. LinkedIn posting 5x/week. SEO optimization active.

3. **Public launch**: Pricing page live with cohort counter. PR/announcement. "Founding member pricing — limited spots" messaging.

4. **Referral activation**: Existing users can refer colleagues. Referrer gets their price locked + 1 month free. Referee gets current cohort price (which they'd pay anyway, but the referral feels like they're helping a friend get a better deal before price goes up).

### 2.2 Continuous Optimization Loop

The system should continuously:

```
1. Collect data (signups, churn, support tickets, feature requests, errors)
2. Analyze patterns (what's working, what's not)
3. Generate hypotheses (e.g., "conversion drops when price hits $44.99")
4. Design experiments (A/B test a different price point, copy change)
5. Run experiments (deploy variant, measure for statistical significance)
6. Apply winners (automatically if confidence > 0.9, else escalate)
7. Log everything (for human review in weekly Telegram report)
```

### 2.3 Revenue Milestones

| Milestone | Action |
|-----------|--------|
| First paid user | Celebrate. Log everything about what converted them. |
| $500 MRR | Marketing Agent increases content output. Dev Agent builds referral system. |
| $2,000 MRR | Begin Practice tier outreach. Dev Agent builds team features. |
| $5,000 MRR | Trigger cloud migration planning. Ops Agent prepares Docker containers. |
| $10,000 MRR | Execute cloud migration. Begin Enterprise tier outreach. |
| $25,000 MRR | Hire first human (customer success). Scale marketing spend. |

---

## PHASE 3: SELF-IMPROVEMENT

### 3.1 Agent Self-Review

Every Sunday, each agent reviews its own performance:
- What tasks did I complete successfully?
- What tasks failed and why?
- What was my confidence accuracy? (Was I right when I was confident?)
- What decisions did the human override? Why?
- What can I do differently?

Results posted to Telegram weekly summary.

### 3.2 Inter-Agent Feedback

Agents provide feedback to each other:
- Support Agent → Dev Agent: "These 5 bugs are most reported by users"
- Marketing Agent → Dev Agent: "Users are asking for feature X in droves"
- Ops Agent → Dev Agent: "This endpoint is slow, needs optimization"
- Compliance Agent → All: "New HIPAA requirement affects data handling"
- Dev Agent → Marketing Agent: "New feature shipped, here are the talking points"

### 3.3 Human Feedback Loop

When Eric makes a decision via Telegram:
1. Log the decision and context
2. Analyze: would the agent have made the same decision?
3. If different: why? Update agent's decision-making parameters
4. Over time: agent decisions should converge with human decisions
5. Escalation rate should decrease as agents learn

---

## SECURITY & GUARDRAILS

### Agent Permissions

| Agent | Can Read | Can Write | Can Deploy | Can Spend Money | Can Delete |
|-------|----------|-----------|------------|-----------------|------------|
| Orchestrator | All | Task board only | No | No | No |
| Dev | Code, tests, configs | Code, tests, configs | Yes (with CI/CD) | No | No |
| Ops | Logs, metrics, health | Configs, rollbacks | Yes (rollback only) | No | No |
| Support | Tickets, KB | Tickets, KB | No | No | No |
| Marketing | Content, analytics | Content, social posts | No | With approval | No |
| Compliance | All (audit) | Audit logs | No | No | No |

### Kill Switches

Telegram commands:
- `/status` — All agent statuses
- `/kill <agent>` — Immediately stop an agent
- `/resume <agent>` — Resume a stopped agent
- `/spend` — Current daily spend per agent
- `/pause all` — Emergency stop all agents
- `/resume all` — Resume all agents

### Budget Limits

Daily budget per agent (adjustable):
- Orchestrator: $20
- Dev: $50
- Ops: $10
- Support: $30
- Marketing: $30
- Compliance: $10
- **Total daily max: $150**
- **Monthly max: ~$4,500**

If any agent hits 80% of daily budget → Telegram alert.
If any agent hits 100% → auto-pause, Telegram alert.

---

## PRICING ENGINE REFERENCE

The pricing engine lives at `src/utils/pricingEngine.js`. Three distinct models:

### Individual Physician — Cohort Escalation

$2 increase per 50-user cohort. Hard cap at $14.99 ($5 under MedRenewal's $20/mo).

| Cohort | Users | Monthly | Annual/mo | Phase | vs Competition |
|--------|-------|---------|-----------|-------|----------------|
| 1 | 1-50 | $4.99 | $3.99 | Founding Member | 75% under |
| 2 | 51-100 | $6.99 | $5.99 | Early Adopter | 65% under |
| 3 | 101-150 | $8.99 | $7.99 | Early Adopter | 55% under |
| 4 | 151-200 | $10.99 | $8.99 | Approaching Cap | 45% under |
| 5 | 201-250 | $12.99 | $10.99 | Approaching Cap | 35% under |
| 6 | 251+ | $14.99 | $11.99 | Cap | 25% under |

### Practice — Flat Pricing (20% Under Competition)

No cohort escalation. Benchmarked against market avg ~$150/mo for small group credentialing.

| Monthly | Annual/mo | Max Providers | vs Competition |
|---------|-----------|---------------|----------------|
| $119.99 | $95.99 | 10 | 20% under market |

### Enterprise — Flat Pricing (20% Under Competition)

No cohort escalation. Benchmarked against Symplr $540/mo entry.

| Monthly | Annual/mo | Max Providers | vs Competition |
|---------|-----------|---------------|----------------|
| $429.99 | $322.99 | Unlimited | 20% under Symplr |

### Price Lock Guarantee

- Users keep their signup price forever
- Price NEVER increases for existing customers
- If price ever drops, existing customers automatically get the lower price
- This is displayed prominently on the pricing page as a trust signal

### 30-Day Money-Back Guarantee

- Full refund within 30 days, no questions asked
- Handled via Stripe refund API
- Support Agent can process; Orchestrator logs it

---

## MONITORING & REPORTING

### Daily Metrics (logged to SQLite)

- Total users (by plan)
- New signups today
- Churn today
- MRR (monthly recurring revenue)
- Support tickets (opened, resolved, escalated)
- Deployments (successful, failed)
- Error rate
- API spend (by agent)
- Content published

### Weekly Telegram Report

Every Sunday, the Orchestrator sends:

```
📊 WEEKLY REPORT — CredentialDOMD

REVENUE
• MRR: $X,XXX (+X% vs last week)
• New signups: XX (Cohort X active)
• Churn: X users
• Current pricing: Individual $XX.99 (Cohort X) / Practice $119.99 / Enterprise $429.99

PRODUCT
• Deployments: X successful, X failed
• Bugs fixed: X
• Features shipped: [list]
• Error rate: X.X%

SUPPORT
• Tickets: X opened, X resolved, X escalated
• Auto-resolution rate: XX%

MARKETING
• Content published: X blog, X social, X email
• Landing page conversion: X.X%
• Top traffic source: [source]

OPERATIONS
• Uptime: XX.X%
• Avg response time: XXXms
• API spend: $XXX (XX% of budget)

AGENT PERFORMANCE
• Tasks completed: XX
• Escalations: X
• Human overrides: X

DECISIONS NEEDED: [list any pending escalations]
```

---

## FILE STRUCTURE

```
CredentialDOMD/
├── agents/
│   ├── orchestrator/
│   │   ├── agent.py          # Main orchestrator loop
│   │   ├── telegram_bot.py   # Telegram integration
│   │   └── scheduler.py      # APScheduler config
│   ├── dev/
│   │   ├── agent.py          # Dev agent logic
│   │   ├── test_generator.py # Auto test generation
│   │   ├── bug_fixer.py      # Sentry → fix pipeline
│   │   └── deployer.py       # CI/CD management
│   ├── ops/
│   │   ├── agent.py          # Ops agent logic
│   │   ├── health_checks.py  # Endpoint monitoring
│   │   └── remediation.py    # Auto-fix playbooks
│   ├── support/
│   │   ├── agent.py          # Support agent logic
│   │   ├── knowledge_base.py # FAQ/KB management
│   │   └── ticket_router.py  # Ticket classification
│   ├── marketing/
│   │   ├── agent.py          # Marketing agent logic
│   │   ├── content_gen.py    # Blog/social generation
│   │   ├── email_campaigns.py # Drip sequences
│   │   └── analytics.py      # Conversion tracking
│   ├── compliance/
│   │   ├── agent.py          # Compliance agent logic
│   │   ├── auditor.py        # Data access auditing
│   │   └── regulatory.py     # Board change monitoring
│   ├── shared/
│   │   ├── state/
│   │   │   └── agent_state.db # SQLite state database
│   │   ├── logs/              # Structured JSON logs
│   │   └── queue/             # Task queue files
│   └── config/
│       ├── .env               # Secrets (gitignored)
│       └── agent_config.yaml  # Agent parameters
├── src/                       # Existing React app
│   └── utils/
│       └── pricingEngine.js   # Cohort pricing algorithm
├── .github/
│   └── workflows/
│       ├── ci.yml             # Lint + test + build
│       └── deploy.yml         # Auto-deploy to Netlify
├── AUTONOMOUS_SYSTEM_SPEC.md  # This file
└── CLAUDE.md                  # Project instructions
```

---

## GETTING STARTED

For Claude Code: execute these in order. Don't set a timeline. Just move through them as fast as possible.

1. Set up the SQLite database and agent state
2. Build the Telegram bot integration
3. Build the Orchestrator (main loop + scheduling)
4. Build the Dev Agent → immediately start generating tests
5. Set up CI/CD pipeline (GitHub Actions)
6. Build the pricing page component
7. Build the signup/payment flow (Stripe)
8. Set up Sentry error tracking
9. Build the Ops Agent → start monitoring
10. Build the Support Agent → prepare for users
11. Build the Marketing Agent → start content generation
12. Build the Compliance Agent → start auditing
13. Soft launch to first 50 users
14. Activate growth loops
15. Optimize continuously

**The system should be building and improving itself from step 4 onward. The Dev Agent writes its own tests, the Ops Agent monitors the system as soon as it exists, and the Marketing Agent starts generating content the moment it's alive.**

---

## DECISION FRAMEWORK

When any agent faces a decision, use this framework:

1. **Can I handle this with >80% confidence?** → Do it, log it.
2. **Is this reversible?** → If yes and confidence >60%, do it. If no, escalate.
3. **Does this involve money?** → Escalate to human.
4. **Does this involve user data deletion?** → Escalate to human.
5. **Does this affect production?** → If bug fix, auto-deploy. If new feature, escalate.
6. **Am I stuck after 2 attempts?** → Escalate with full context.
7. **Is this outside my department?** → Route to correct agent via task board.

**Default: When in doubt, escalate. It's always better to ask than to break something.**

---

## CHECKS AND BALANCES

Every agent decision flows through verification layers before affecting production, user data, or finances.

### Decision Authority Levels

| Level | Authority | Examples | Approval |
|-------|-----------|----------|----------|
| L0 — Routine | Agent acts autonomously | Bug fix, content draft, health check, test run | None (logged) |
| L1 — Significant | Agent acts, notifies human | Dependency update, deploy, email campaign | Post-action review |
| L2 — Sensitive | Agent proposes, human approves | New feature deploy, pricing change, A/B test | Pre-action Telegram approval |
| L3 — Critical | Human decides, agent executes | Refund, data deletion, production rollback, financial | Explicit Telegram command |

### Cross-Agent Verification

No single agent can make high-impact changes unilaterally:
- **Code changes:** Dev Agent writes code, Compliance Agent audits for security/HIPAA before merge
- **Marketing content:** Marketing Agent drafts, Support Agent reviews for accuracy
- **Deployments:** Dev Agent builds, Ops Agent validates health checks before promoting to production
- **Support responses:** Above 0.8 confidence → auto-respond. Below 0.8 → route to Dev or escalate to human
- **Financial actions:** ALL Stripe operations (refunds, plan changes, pricing) require human Telegram approval

### Audit Trail

Every decision logged to SQLite `decisions` table: timestamp, agent, task_id, decision, reasoning, confidence, outcome, model_used, tokens_used, cost_usd. Complete audit trail feeds weekly Telegram reports and enables post-mortem analysis.

---

## CRASH RESILIENCE AND BACKUP SYSTEMS

The system survives crashes, network failures, hung processes, and cascading failures without losing state.

### Process Supervision

- All agents run as macOS `launchd` services with `KeepAlive = true` (auto-restart on crash)
- Each agent writes a heartbeat to SQLite every 60 seconds
- Orchestrator detects missing heartbeats (5 min threshold) → force-restart + Telegram alert
- If Orchestrator crashes, launchd restarts it. On startup, it checks for agents that went unhealthy
- Maximum 5 restarts/hour per agent. After 5 → agent marked as `killed`, critical Telegram alert

### Task Durability

- All tasks persisted to SQLite **before** execution begins (write-ahead pattern)
- On agent restart → scan for `in_progress` tasks → resume or requeue based on idempotency
- Tasks have `retry_count` field. After 3 failures → escalate to human with full error context
- Long-running tasks use checkpoints. If interrupted, resume from last checkpoint

### Data Backup Strategy

| Data | Backup Method | Frequency | Retention |
|------|--------------|-----------|-----------|
| SQLite agent state | File copy to ~/Backups/ + Supabase sync | Hourly | 30 days |
| Supabase (user data) | Supabase built-in daily backups | Daily | Per plan |
| Git repository | GitHub (remote origin) | Every commit | Forever |
| Agent configs | Git-tracked in agents/config/ | Every change | Forever |
| Stripe data | Stripe dashboard (source of truth) | Real-time | Forever |
| Decision logs | SQLite + weekly JSON export | Continuous | 90 days local |

### Graceful Degradation

When components fail, the system degrades gracefully:
- **Claude API down:** Agents switch to Ollama for routing/triage. High-complexity tasks queue. Telegram alert
- **Supabase down:** App continues with localStorage fallback (PWA). New signups queue. Agents pause user-data ops
- **Netlify down:** DNS failover alert. Ops Agent monitors recovery. Status page auto-updated
- **Telegram down:** Alerts queue locally in SQLite. Flush when connection restores. Email fallback for critical
- **Mac Mini power loss:** launchd restarts all on boot. Agents recover from SQLite state. WAL mode = no data loss
- **Single agent crash:** Other agents continue independently. Orchestrator redistributes pending tasks if critical

### Anti-Hang Protection

- Every task has a timeout (5 min default, 30 min for complex). Exceeded → force-kill + requeue
- API calls: 60-second timeout, exponential backoff, 3 retries. After 3 failures → abandon + escalate
- Memory monitoring: Agent exceeds 2GB RAM → force-restart. 16GB Mac Mini supports all 6 at ~1GB each
- Deadlock detection: Circular dependency in task board → Orchestrator breaks cycle by requeuing lower-priority task
- **No long-running chat sessions.** Agent conversations use stateless request-response. Each task = independent invocation with full context passed in. This eliminates chat hangs entirely.

### Circuit Breakers

| Trigger | Action | Recovery |
|---------|--------|----------|
| 3 failed tasks in 1 hour | Pause agent, Telegram alert | Human `/resume` or auto-resume after 1 hour |
| Daily budget exceeded | Pause agent, Telegram alert | Resets at midnight, human can override |
| No heartbeat for 5 min | Force restart, Telegram alert | Automatic, up to 5 times/hour |
| 5 restarts in 1 hour | Kill agent, critical alert | Human must investigate and `/resume` |
| Error rate >5% post-deploy | Auto-rollback deployment | Dev Agent investigates |
| API rate limit hit | Backoff + queue tasks | Auto-resume after cooldown |
