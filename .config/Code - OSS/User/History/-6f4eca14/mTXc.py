#!/usr/bin/env python3
import requests
import sys
import time
from concurrent.futures import ThreadPoolExecutor
import json
from concurrent.futures import ThreadPoolExecutor, as_completed

    def scan_range(self, start_port, end_port):
        open_ports = []
        # Do not use the 'with' context manager here
        ex = ThreadPoolExecutor(max_workers=20)
        futures = {ex.submit(self.test_port_simple, p): p for p in range(start_port, end_port + 1)}
        
        try:
            # Yield results as they complete, allowing the main thread to stay responsive
            for future in as_completed(futures):
                port = futures[future]
                try:
                    # If the port is open, add it to the list
                    if future.result():
                        print(f"[+] Port {port} is open") # Added print for real-time feedback
                        open_ports.append(port)
                except Exception as e:
                    pass
                    
        except KeyboardInterrupt:
            print("\n[!] Ctrl+C detected. Cancelling scan and shutting down...")
            # 1. Cancel all futures that haven't started yet
            for future in futures:
                future.cancel()
            # 2. Shut down the executor without waiting for running tasks to finish
            ex.shutdown(wait=False, cancel_futures=True)
            print("[!] Shutdown complete.")
            # Exit gracefully
            sys.exit(0)
            
        else:
            # If it finishes naturally, clean up normally
            ex.shutdown(wait=True)
            
        return open_ports

def main():
    TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpZCI6IjJkOWYwZDllLTA5MzUtNDlmMy1hZmNkLTI5YWJkMzQyNzAxMSIsInVzZXJuYW1lIjoiYWRtaW4iLCJwcml2aWxlZ2VMZXZlbCI6Miwid2l0aFBhc3NrZXkiOnRydWUsIm9ubHlGb3JQYXRocyI6bnVsbCwiZXhwIjoxNzczNzY0ODg5fQ.b8RwYFnsY8wEBTJFdXymBJhuR6TpbcMFimwXc4UUo6Q"
    NEXT_ACTION = "99cc053db6c8902cbccf05efda80ea0306624c56"
    requests.packages.urllib3.disable_warnings()

    scanner = SSRFScanner(TOKEN, NEXT_ACTION)
    print(scanner.scan_range(20, 10000))

if __name__ == "__main__":
    main()
