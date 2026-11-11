# Memory recall test

Run: 2026-11-11T11:23:25.053Z · `npm run eval:memory`

**20/20 passed** · recall took 10.3 ms per question on average (no model call) · 0 distillation failure(s)

17 conversations are seeded and distilled by the real write path. The 5 target conversations are older than the 12 filler chats, so they are outside the always-in-view timeline: a pass means the retrievers found the right conversation in the whole history. "Rank" is its position among the conversations recall selected (top 3).

| Question (asked in a new chat) | Why it is hard | Result | Rank | Memory block (chars) | Recall time |
|---|---|---|---|---|---|
| On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since? | brief example | ✅ | #1 | 5662 | 57.7 ms |
| What did I ask you on 3 November? Is your answer still correct today? | brief example: date only, no topic | ✅ | #1 | 4655 | 49.1 ms |
| Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then? | brief example: 'last Tuesday' is ambiguous on a Wednesday | ✅ | #1 | 5931 | 6.7 ms |
| Any update on those CRM tools? | no past-tense cue | ✅ | #1 | 4972 | 5.1 ms |
| that database thing — did it get cheaper? | vague, no product name | ✅ | #1 | 4104 | 19.8 ms |
| which one did we go with in the end for hosting? | asks for a decision | ✅ | #1 | 4386 | 4.3 ms |
| remind me what the plan was for the sales team software | no 'CRM' | ✅ | #1 | 4975 | 5.0 ms |
| Is it still $25? | only an amount | ✅ | #1 | 4098 | 4.4 ms |
| anything new with the tools for my reps? | synonym only | ✅ | #1 | 4796 | 5.1 ms |
| how long have I been using that moisturiser? | synonym + British spelling | ✅ | #1 | 3677 | 3.8 ms |
| what was the F1 result I asked about? | category word only | ✅ | #1 | 3433 | 3.9 ms |
| did you ever suggest a notebook computer to me? | synonym only | ✅ | #1 | 4044 | 3.8 ms |
| where did we land on our backend data store? | paraphrase | ✅ | #1 | 4239 | 4.1 ms |
| what's still undecided from our software purchasing chat? | asks for an open item | ✅ | #1 | 5311 | 4.6 ms |
| Is Pipedrive still the cheapest of the five? | entity + implicit set | ✅ | #1 | 4977 | 5.4 ms |
| my skin routine — what did you recommend for cold weather? | paraphrase | ✅ | #1 | 3696 | 4.1 ms |
| what was I looking into at the start of last week? | date range only | ✅ | #1 | 6386 | 5.9 ms |
| the race in Mexico — who came first? | paraphrase | ✅ | #1 | 3705 | 4.3 ms |
| What's the weather in Mumbai today? | control: nothing to recall | ✅ | – | 3326 | 4.1 ms |
| How do I reverse a string in JavaScript? | control: nothing to recall | ✅ | – | 3340 | 4.2 ms |

## Write-path checks: **8/8 passed**

| Check | Result | Detail |
|---|---|---|
| CRM chat has the HubSpot-vs-Pipedrive choice open after seeding | ✅ | Choose between HubSpot Sales Hub Professional and Pipedrive Growth after Friday's demo |
| Asking about it does NOT close it | ✅ | Choose between HubSpot Sales Hub Professional and Pipedrive Growth after Friday's demo |
| Saying the outcome in a NEW chat closes it in the CRM chat | ✅ | open: (none) · decided: chose HubSpot Sales Hub Professional after the demo (said 2026-11-11, in a later chat) |
| Facts are stored under the company's name, not a plan's | ✅ | entities: HubSpot, Pipedrive, Salesforce, Zoho CRM, Close, Neon, Supabase |
| A chat whose distillation never ran is caught up and recallable | ✅ | caught up 1 exchange(s); aliases: headphones, travel headphones, ANC headphones, noise cancelling, airplane headphones, flight audio gear, over-ear headphones, travel audio; recalled: Noise-cancelling headphones for flights |
| A changed profile fact keeps its earlier value | ✅ | Pune → Bengaluru |
| Forgetting the chat that changed it restores the earlier value | ✅ | after forgetting "Hiring update": Pune |
| More than 12 profile facts all reach the model | ✅ | 18 facts stored |

## What the write path stored for the target conversations

**Lightweight laptop for travel**
- Summary: User asked for a lightweight travel laptop under $1500. Assistant recommended the MacBook Air 13 M4 ($1,099) and the ThinkPad X1 Carbon Gen 13 ($1,449). No sources were cited, and the user has not chosen between them.
- Topics: laptops, travel laptops, laptop buying, budget laptops
- Aliases: laptop, notebook, ultrabook, portable computer, travel computer, lightweight laptop, laptop purchase, computer for travel
- Decided: –
- Left open: Choose between MacBook Air 13 M4 and ThinkPad X1 Carbon Gen 13

**CRM shortlist for a 20-person sales team**
- Summary: User leading a 20-person sales team asked for a shortlist of 5 CRM tools with pricing. Assistant recommended HubSpot Sales Hub Professional ($100/seat/month), Pipedrive Growth ($39/seat/month), Salesforce Pro Suite ($100/user/month), Zoho CRM Professional ($23/user/month), and Close Growth ($99/seat/month). User narrowed the choice to HubSpot and Pipedrive, to be decided after a demo on Friday; assistant offered to re-check both prices afterward.
- Topics: crm software, sales software, crm pricing, sales team tools
- Aliases: crm, sales crm, customer relationship management, sales tool, pipeline software, crm shortlist, hubspot vs pipedrive, sales demo
- Decided: chose HubSpot Sales Hub Professional after the demo (said 2026-11-11, in a later chat)
- Left open: –

**Barrier cream for dry skin**
- Summary: User said they have used a barrier repair cream for two years and asked whether something better exists for winter. Assistant asked which cream they use. User identified it as Bioderma Atoderm. Assistant suggested Atoderm Intensive Baume as a richer option for winter, without sources.
- Topics: skincare, moisturizers, winter skin care, barrier repair creams
- Aliases: face cream, body moisturizer, skin cream, emollient, dry skin remedy, winter skincare, barrier cream, that Bioderma cream
- Decided: –
- Left open: Whether to switch from Bioderma Atoderm to a richer winter cream such as Atoderm Intensive Baume

**Who won the Mexico City Grand Prix?**
- Summary: User asked who won the Mexico City Grand Prix. Assistant answered that Lando Norris won from pole position. No sources were cited, so the result is unverified.
- Topics: formula 1, motorsport race results, mexico city grand prix
- Aliases: F1, formula one, motor racing, grand prix results, f1 race winner, Mexican GP, racing results
- Decided: –
- Left open: –

**Managed Postgres hosting options**
- Summary: User asked for managed Postgres hosting options and costs for a small startup. Assistant suggested Neon (Launch plan about $19/month), Supabase (Pro $25/month), and AWS RDS (pay-as-you-go), recommending Neon or Supabase. User chose Supabase for now; assistant confirmed Supabase Pro at $25/month.
- Topics: managed databases, postgres hosting, database pricing, backend infrastructure
- Aliases: database, db hosting, cloud database, postgres, where to host our data, backend hosting, data hosting, db pricing
- Decided: chose Supabase for hosting Postgres for now
- Left open: –
