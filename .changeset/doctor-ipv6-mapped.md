---
"posterna": patch
---

`posterna doctor` no longer runs its IPv6 check over IPv4 on macOS. For a site with no IPv6 address, macOS answers an IPv6 lookup with IPv4-mapped addresses (`::ffff:a.b.c.d`), so the "Client IP (IPv6)" row compared an IPv4 address with an IPv6 one and printed a confusing WARN. Doctor now drops those addresses and reports `SKIP: not checked: the site has no IPv6 address.`, as it already did on Linux. Its whoami request over IPv6 goes through the same lookup, so it cannot report an IPv4 address as this machine's IPv6 one.
