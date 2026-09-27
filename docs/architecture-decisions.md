# Architecture decisions

Small, permanent records of decisions that are easy to re-litigate by accident.
Each entry says what was decided and which deployment constraint forced it.

## Why no WebSockets

**Status:** decided — 4.0, for the Render free web service.

**Decision.** Archiver will not open WebSocket connections between the browser
and the app server. If streaming is ever needed, the answer is Server-Sent
Events over the existing HTTP handler: one-directional, closed on completion.

**Reasoning.** The deployment target decides this, not taste:

1. **There is nothing to push.** Inference runs entirely client-side
   (`web-llm` / `wllama`, vendored). Tokens are generated in the visitor's own
   browser, so there is no server-side token stream a socket could carry. The
   server's jobs are serving static bytes and performing request/response web
   fetches for search and retrieval — both naturally HTTP.

2. **A socket holds the instance awake.** The free tier spins down after ~15
   minutes idle; spin-down is the free tier's only cost control. An open
   connection counts as activity, so a persistent socket quietly converts the
   service from "sleeps when unused" to "always on", and an idle-but-connected
   tab is exactly the workload the tier is not priced for.

3. **Every frame is billed in the priciest bandwidth meter.** Render meters
   *WebSocket Responses*, *Service-Initiated*, and *Service-Initiated (Private
   Link)* against one shared monthly allowance. WebSocket traffic lands in the
   most expensive category, and heartbeat frames are pure meter burn — bytes
   with no information in them. Exceeding the allowance throttles the service;
   there is no overage billing to absorb the mistake.

4. **Reconnect storms on wake.** After a spin-down every parked client
   reconnects at once when the instance wakes — a thundering herd against a
   shared CPU during the slowest part of the cold start, and each reconnect is
   another metered handshake. A request/response client instead simply waits
   for the one slow response, which is what the "waking the server" status in
   the UI already explains.

**Consequences.** No persistent connection state on the server (nothing to lose
on an ephemeral disk), no keep-alive pinger to keep the instance hot (that
would defeat spin-down *and* burn the same bandwidth meter), and any future
streaming feature must fit inside a bounded HTTP response that closes when it
ends. SSE satisfies that; WebSockets never can.
