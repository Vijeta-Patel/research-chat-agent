# Memory recall test

Run: 2026-11-11T11:09:09.908Z · `npm run eval:memory`

**20/20 passed** · recall took 10.2 ms per question on average (no model call) · 0 distillation failure(s)

17 conversations are seeded and distilled by the real write path. The 5 target conversations are older than the 12 filler chats, so they are outside the always-in-view timeline: a pass means the retrievers found the right conversation in the whole history. "Rank" is its position among the conversations recall selected (top 3).

| Question (asked in a new chat) | Why it is hard | Result | Rank | Memory block (chars) | Recall time |
|---|---|---|---|---|---|
| On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since? | brief example | ✅ | #1 | 5725 | 63.4 ms |
| What did I ask you on 3 November? Is your answer still correct today? | brief example: date only, no topic | ✅ | #1 | 4702 | 51.3 ms |
| Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then? | brief example: 'last Tuesday' is ambiguous on a Wednesday | ✅ | #1 | 6105 | 6.7 ms |
| Any update on those CRM tools? | no past-tense cue | ✅ | #1 | 5033 | 4.5 ms |
| that database thing — did it get cheaper? | vague, no product name | ✅ | #1 | 5368 | 16.8 ms |
| which one did we go with in the end for hosting? | asks for a decision | ✅ | #1 | 4433 | 3.3 ms |
| remind me what the plan was for the sales team software | no 'CRM' | ✅ | #1 | 5038 | 3.9 ms |
| Is it still $25? | only an amount | ✅ | #1 | 4145 | 3.2 ms |
| anything new with the tools for my reps? | synonym only | ✅ | #1 | 4859 | 4.5 ms |
| how long have I been using that moisturiser? | synonym + British spelling | ✅ | #1 | 3690 | 4.5 ms |
| what was the F1 result I asked about? | category word only | ✅ | #1 | 3444 | 3.4 ms |
| did you ever suggest a notebook computer to me? | synonym only | ✅ | #1 | 3759 | 3.4 ms |
| where did we land on our backend data store? | paraphrase | ✅ | #1 | 4264 | 4.0 ms |
| what's still undecided from our software purchasing chat? | asks for an open item | ✅ | #1 | 4705 | 4.3 ms |
| Is Pipedrive still the cheapest of the five? | entity + implicit set | ✅ | #1 | 5040 | 5.4 ms |
| my skin routine — what did you recommend for cold weather? | paraphrase | ✅ | #1 | 3709 | 3.6 ms |
| what was I looking into at the start of last week? | date range only | ✅ | #1 | 6399 | 5.7 ms |
| the race in Mexico — who came first? | paraphrase | ✅ | #1 | 3716 | 4.1 ms |
| What's the weather in Mumbai today? | control: nothing to recall | ✅ | – | 3355 | 3.9 ms |
| How do I reverse a string in JavaScript? | control: nothing to recall | ✅ | – | 3369 | 3.2 ms |

## What the write path stored for the target conversations

**Lightweight laptop for travel**
- Summary: The user asked for a lightweight travel laptop under $1500. The assistant recommended the MacBook Air 13 M4 ($1,099) or the ThinkPad X1 Carbon Gen 13 ($1,449). The user has not yet chosen between them. The answer cited no sources.
- Topics: laptops, travel laptops, laptop shopping, budget electronics
- Aliases: notebook, ultrabook, portable computer, travel computer, lightweight laptop, work laptop, laptop buying advice, portable notebook
- Decided: –
- Left open: Choose between MacBook Air 13 M4 and ThinkPad X1 Carbon Gen 13

**CRM shortlist for a 20-person sales team**
- Summary: User's 20-person sales team asked for a 5-tool CRM shortlist with pricing. Assistant recommended HubSpot Sales Hub Professional ($100/seat/month), Pipedrive Growth ($39/seat/month), Salesforce Pro Suite ($100/user/month), Zoho CRM Professional ($23/user/month), and Close Growth ($99/seat/month). User narrowed the choice to HubSpot vs Pipedrive, to be decided after a Friday demo. Assistant offered to re-check both prices before a commitment.
- Topics: crm software, sales software, crm pricing, sales tools
- Aliases: crm, sales crm, customer relationship management, sales pipeline tool, crm comparison, hubspot vs pipedrive, sales team software, customer database
- Decided: –
- Left open: Choose between HubSpot Sales Hub Professional and Pipedrive Growth after Friday demo; Re-check HubSpot and Pipedrive prices before committing

**Barrier cream for dry skin**
- Summary: User said they have used a barrier repair cream for about two years and asked whether something better exists for winter. Assistant asked which cream they use. User replied Bioderma Atoderm. Assistant suggested Atoderm Intensive Baume as a richer winter option. No sources were cited.
- Topics: skincare, moisturizers, barrier repair creams, winter skin care, dry skin
- Aliases: moisturiser, face cream, body cream, eczema cream, dry skin cream, winter skincare, emollient, skin barrier product
- Decided: –
- Left open: Decide whether to switch from Bioderma Atoderm to a richer winter cream

**Who won the Mexico City Grand Prix?**
- Summary: The user asked who won the Mexico City Grand Prix. The assistant answered Lando Norris, from pole position, without citing any sources, so the result is unverified.
- Topics: formula 1, motorsport, race results
- Aliases: F1, Formula One, Mexican GP, motor racing, grand prix results, F1 race winner, Mexico race, F1 standings
- Decided: –
- Left open: –

**Managed Postgres hosting options**
- Summary: User asked for good managed Postgres hosting options for a small startup and their costs. Assistant suggested Neon (Launch plan about $19/month), Supabase (Pro $25/month), and AWS RDS (pay-as-you-go), recommending Neon or Supabase to start. User chose Supabase for now; assistant confirmed Supabase Pro at $25/month.
- Topics: managed databases, postgres hosting, database pricing, cloud infrastructure
- Aliases: database, db hosting, cloud database, backend infrastructure, where to host our data, postgres hosting, database vendor choice
- Decided: Chose Supabase for now for Postgres hosting
- Left open: –
