"""Network diagnostic script for Geo-Tagger.

Run this to diagnose network connectivity issues.
"""
import socket
import subprocess
import sys

def main():
    port = 8000

    print("=" * 60)
    print("Geo-Tagger Network Diagnostics")
    print("=" * 60)
    print()

    # Get hostname
    hostname = socket.gethostname()
    print(f"Hostname: {hostname}")
    print()

    # Get all IP addresses
    print("Network interfaces and IP addresses:")
    try:
        # Get all IPv4 addresses
        addr_info = socket.getaddrinfo(hostname, None, socket.AF_INET)
        ips = set()
        for info in addr_info:
            ip = info[4][0]
            ips.add(ip)

        for ip in sorted(ips):
            if ip.startswith("127."):
                print(f"  {ip} (localhost)")
            else:
                print(f"  {ip} (network)")
    except Exception as e:
        print(f"  Error: {e}")
    print()

    # Check if port is in use
    print(f"Checking if port {port} is available:")
    try:
        test_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        test_socket.settimeout(1)
        result = test_socket.connect_ex(('127.0.0.1', port))
        test_socket.close()

        if result == 0:
            print(f"  ✓ Port {port} is in use (server might be running)")
        else:
            print(f"  ✗ Port {port} is not in use (server not running)")
    except Exception as e:
        print(f"  Error: {e}")
    print()

    # Check netstat
    print(f"Active listeners on port {port}:")
    try:
        result = subprocess.run(
            ["netstat", "-ano"],
            capture_output=True,
            text=True,
            timeout=5
        )
        lines = [line for line in result.stdout.split('\n') if f':{port}' in line and 'LISTEN' in line]
        if lines:
            for line in lines:
                print(f"  {line.strip()}")
                if '0.0.0.0' in line:
                    print("  ✓ Server is listening on all interfaces (0.0.0.0)")
                elif '127.0.0.1' in line:
                    print("  ⚠ Server is only listening on localhost (not accessible from network)")
        else:
            print(f"  No listeners found on port {port}")
    except Exception as e:
        print(f"  Error: {e}")
    print()

    # Check Windows Firewall rules
    print("Checking Windows Firewall rules for port 8000:")
    try:
        result = subprocess.run(
            ["netsh", "advfirewall", "firewall", "show", "rule", "name=all"],
            capture_output=True,
            text=True,
            timeout=5
        )
        # Look for rules that mention port 8000
        lines = result.stdout.split('\n')
        found_rule = False
        current_rule = []

        for line in lines:
            if line.startswith('Rule Name:'):
                if current_rule and any('8000' in l for l in current_rule):
                    found_rule = True
                    print("  Found firewall rule:")
                    for rule_line in current_rule:
                        print(f"    {rule_line}")
                    print()
                current_rule = [line.strip()]
            elif line.strip():
                current_rule.append(line.strip())

        # Check last rule
        if current_rule and any('8000' in l for l in current_rule):
            found_rule = True
            print("  Found firewall rule:")
            for rule_line in current_rule:
                print(f"    {rule_line}")
            print()

        if not found_rule:
            print("  ⚠ No firewall rules found for port 8000")
            print("  This is likely the issue - Windows Firewall is blocking connections")
            print()
            print("  To fix, run this command as Administrator:")
            print(f'  New-NetFirewallRule -DisplayName "Geo-Tagger" -Direction Inbound -Protocol TCP -LocalPort {port} -Action Allow')
    except Exception as e:
        print(f"  Could not check firewall rules: {e}")
    print()

    print("=" * 60)
    print("Recommended actions:")
    print("=" * 60)
    print()
    print("1. Make sure the server is running with the --network flag")
    print("2. Verify the server is listening on 0.0.0.0 (check netstat output above)")
    print("3. Create a Windows Firewall rule to allow port 8000 (see above)")
    print("4. Test from this computer using the IP address (not localhost)")
    print("5. Then test from another device on the same network")
    print()
    print("Test URLs to try:")
    for ip in sorted(ips):
        if not ip.startswith("127."):
            print(f"  http://{ip}:{port}/")
    print()

if __name__ == "__main__":
    main()
