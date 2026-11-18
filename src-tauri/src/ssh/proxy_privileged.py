print("VPS_PROXY_READY", flush=True)
try:
    print(json.dumps(main(json.loads(sys.stdin.readline(3 * 1024 * 1024))), ensure_ascii=False), flush=True)
except Exception as error:
    print(json.dumps({'error': str(error) if isinstance(error, ValueError) else 'Proxy operation failed; inspect before retrying'}), flush=True)
