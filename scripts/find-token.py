import json
import urllib.request

SYMBOLS = {'USDC', 'USDBC'}

url = 'https://tokens.coingecko.com/base/all.json'

with urllib.request.urlopen(url) as resp:
    data = json.load(resp)

for token in data.get('tokens', []):
    symbol = token.get('symbol', '').upper()
    if symbol in SYMBOLS:
        print(symbol, token.get('address'))

