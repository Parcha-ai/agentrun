# A local page under /tmp/computer-bench-{{nonce}} with a table of five orders: customer, order number, total.
set -e
d="/tmp/computer-bench-{{nonce}}"
rm -rf "$d"
mkdir -p "$d"
cat > "$d/orders.html" <<'PAGE'
<!doctype html>
<html><head><meta charset="utf-8"><title>Open orders</title>
<style>body{font-family:-apple-system,sans-serif;margin:2em}td,th{padding:6px 14px;border-bottom:1px solid #ccc;text-align:left}</style>
</head><body>
<h1>Open orders</h1>
<table>
<tr><th>Customer</th><th>Order number</th><th>Total</th></tr>
<tr><td>Ana Ortiz</td><td>ORD-58213</td><td>$42.10</td></tr>
<tr><td>Ben Ito</td><td>ORD-30977</td><td>$18.00</td></tr>
<tr><td>Chloe Ruiz</td><td>ORD-74406</td><td>$105.50</td></tr>
<tr><td>Dev Patel</td><td>ORD-12658</td><td>$63.25</td></tr>
<tr><td>Ema Novak</td><td>ORD-90341</td><td>$7.99</td></tr>
</table>
</body></html>
PAGE
