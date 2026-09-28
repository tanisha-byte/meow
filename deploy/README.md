# deploying meow

meow runs in slack socket mode. it opens an outbound websocket to slack and
never receives an inbound request. so it needs an always-on process, not a
request-driven web host.

two ways to run it. render if you want free with no card. a vm if you want it
solid.

## option a: render (free, no credit card)

render's free plan gives 750 instance hours a month, which covers one service
running 24/7. no card. the catch is it only offers always-on processes on paid
plans, so meow runs as a free "web service" with two workarounds baked in:

- `src/app.js` binds `$PORT` with a tiny health endpoint so render sees an open
  port. locally `$PORT` is unset and none of it runs.
- render spins a free service down after 15 min with no inbound request. socket
  mode never gets one, so an external pinger has to hit the health url.

setup:

1. push this repo to github (render deploys from a repo, not from your laptop)
2. render.com, sign up with github, new > blueprint, pick the repo. it reads
   `render.yaml` and asks for the env vars
3. paste `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `ANTHROPIC_API_KEY`,
   `BOLNA_API_KEY` from your local `.env`
4. paste `USER_KEYS_JSON` as the one-line contents of
   `data/user-bolna-keys.json`. read the storage note below first
5. copy the service url render gives you. add it to a free pinger
   (cron-job.org or uptimerobot, both no card) every 10 min

### storage on render is ephemeral

the free disk is wiped on every restart and every deploy. without
`USER_KEYS_JSON` all 5 fdes get logged out and have to re-run `/meow-connect`
each time render bounces the service.

so `USER_KEYS_JSON` is the durable baseline, and the on-disk file wins over it
when both have the same user. anyone who runs `/meow-connect` after deploy
persists only until the next restart. to make them durable, copy their entry
into the env var.

this is the real cost of the free tier. if you get tired of it, the vm below
has a real disk.

## option b: a vm (gcp, oracle, anything)

needs a card to sign up even where the box itself is free. in exchange you get
a real disk, no pinger, no 15 min spin down, and systemd restarting it.

gcp e2-micro is free including the external ip, in us-central1, us-west1 or
us-east1. oracle ampere is free and much bigger but arm capacity is often
unavailable. ubuntu 22.04 or 24.04 either way. no firewall rules needed,
socket mode is outbound only.

one time, on the box:

```sh
scp deploy/bootstrap.sh deploy/meow.service <user>@<vm-ip>:~
ssh <user>@<vm-ip> 'sudo bash bootstrap.sh'
```

then from the repo root on your laptop:

```sh
./deploy/push.sh <user>@<vm-ip>
```

that copies the code, copies `.env`, seeds `data/user-bolna-keys.json` so the
5 registered fdes stay registered, installs deps and starts the service.
every deploy after that is just `push.sh` again.

day to day:

```sh
ssh <vm> 'sudo systemctl status meow'      # is it up
ssh <vm> 'sudo journalctl -u meow -f'      # live logs
ssh <vm> 'sudo systemctl restart meow'     # bounce it
```

systemd replaces `scripts/run-forever.sh` there. the app exits on purpose when
it hits an unhandled error and `Restart=always` brings it back in 3s. it also
starts on boot, so a reboot is not an outage.

## gotchas, both options

**only run one meow at a time.** two socket mode connections on the same slack
app split events between them. half the requests go to one process, and a
confirm card posted by one can get clicked into the other, which answers "this
already resolved or expired". if something is hosted, kill the laptop copy:

```sh
pkill -f run-forever.sh; pkill -f "node src/app.js"
```

**`.env` and `data/` are gitignored and never committed.** they reach a host
only through render's env vars or push.sh. a rebuilt box needs both again.

**render free is 750 hours a month.** one service 24/7 is about 730. running a
second service, even briefly, can push you over and suspend both until the
month rolls.
