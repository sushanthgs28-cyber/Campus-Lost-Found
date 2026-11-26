# Campus Lost & Found: implementation

A real, multi-user version of the Campus Lost & Found app for REVA.

```
campus-lost-found/
  supabase/schema.sql   database tables, security rules, server functions, photo bucket
  web/                  the website (plain HTML, CSS, JavaScript; no build step)
  ai_service/           optional AI photo and text matching (Python, FastAPI, CLIP)
```

## How it works
- **Sign-in:** Supabase Auth, limited to your university email domain.
- **Database:** PostgreSQL. Posts live in `items`. The hash of the hidden detail and the finder's contact live in `item_secrets`, which no client can read.
- **Rules on the server:** the web app can only change data through functions (`create_item`, `claim_item`, `respond_lost`, `set_status`, `delete_item`, `report_item`, `item_contacts`). The server checks the hidden detail, counts wrong tries (3 per user per item), and releases contact details only to the verified owner, the poster and admins.
- **Photos:** shrunk in the browser, stored in the `item-photos` bucket under the user's own folder.
- **Live feed:** Supabase Realtime.
- **AI (optional):** CLIP embeddings and pgvector similarity suggest possible matches. A human check stays mandatory.

## Setup (about 30 minutes)
1. **Create a project** at supabase.com (free tier is enough to start; check current limits).
2. **Database:** open SQL Editor, paste all of `supabase/schema.sql`, run it. If it reports that `vector` or `pgcrypto` is missing, enable them under Database > Extensions and run again.
3. **Email domain:** the file allows only `reva.edu.in`. If your university uses another domain, run `update public.settings set value = 'your-domain' where key = 'allowed_email_domain';` and set the same value in `web/config.js`.
4. **Auth settings:** Authentication > Providers > Email is on by default. For quick testing you can turn off "Confirm email"; for real use keep it on.
5. **Connect the website:** in `web/config.js` set `SUPABASE_URL` and `SUPABASE_ANON_KEY` (Project Settings > API).
6. **Try it locally:** from the `web` folder run `python3 -m http.server 8080` and open http://localhost:8080. Sign up, post an item, claim it with a second account.
7. **Make yourself admin:** after signing up, run in the SQL Editor:
   `update public.profiles set role = 'admin' where id = (select id from auth.users where email = 'you@reva.edu.in');`
8. **Publish the website:** drag the `web` folder into Netlify Drop, or use Vercel or GitHub Pages. In Supabase, Authentication > URL Configuration, add your site URL.

## Optional: AI matching
1. Copy `ai_service/.env.example` to `.env` and fill it in. The service role key is secret: never put it in `web/`.
2. Local test: `pip install -r requirements.txt` then `uvicorn main:app --reload` in `ai_service/`.
3. Deploy the folder (it has a Dockerfile) to Render, Railway or Google Cloud Run. The model needs memory, so pick a plan with at least 2 GB. Check current pricing first.
4. Put the service URL in `AI_URL` in `web/config.js`.
5. `MATCH_THRESHOLD` (default 0.6) is a starting guess. In the pilot, compare suggestions with real lost and found pairs and tune it. Report precision and recall from real data, not guesses.

## Known limits
- Not yet tested against a live Supabase project; run the checklist below first.
- Wrong-guess limit is per user per item, so one person with many accounts could still guess. The domain restriction and admin review reduce this; add rate limiting for a full rollout.
- Photos are publicly readable by link (needed to show them in the feed). Do not post photos showing ID numbers or faces; the AI service does not yet blur or detect them.
- Posts can be edited only by deleting and reposting.

## Test checklist
1. Sign up with a non-university email: it must be refused.
2. Sign up with two university accounts, A and B.
3. A posts a found item with a hidden detail. B sees it in the feed live.
4. B enters a wrong detail three times: the fourth try must be locked.
5. B enters the right detail (capitals and spaces ignored): status becomes Claimed and the finder's contact shows.
6. A third account must not see the finder's contact (`item_contacts` returns nothing).
7. A marks the item returned. An admin sees every post in Moderation.
