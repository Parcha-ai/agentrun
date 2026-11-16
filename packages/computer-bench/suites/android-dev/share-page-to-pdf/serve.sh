# Serve this run's page (written by the setup call before this one) on 127.0.0.1:{{port}} with toybox nc: -L forks one
# handler per connection. setsid and nohup detach the server from exec.run, so it lives until teardown kills it.
f=/data/local/tmp/computer-bench-{{nonce}}
[ -s $f.http ] || exit 1
# The handler reads the request up to its blank line before it answers, so closing the socket doesn't reset it.
printf '%s\n' 'while read -r l; do [ ${#l} -le 1 ] && break; done' "cat $f.http" > $f.sh || exit 1
setsid nohup nc -L -p {{port}} sh $f.sh >/dev/null 2>&1 </dev/null &
sleep 1
# The setup fails (an infra outcome, run again) unless the page is served with this run's code.
printf 'GET / HTTP/1.0\r\n\r\n' | nc 127.0.0.1 {{port}} | grep -q '{{nonce}}'
