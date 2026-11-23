#!/usr/bin/env bash
# Lets only Cloudflare's ranges reach ports 80 and 443 (TCP, and UDP 443),
# for an instance behind Cloudflare's proxy (PROXY=cloudflare;
# docs/deployment.md, "Behind Cloudflare's proxy"). Run with sudo, beside
# compose.yaml, on a server with UFW active:
#
#   sudo ./cloudflare-firewall.sh            write the rules and reload UFW
#   ./cloudflare-firewall.sh --check         print what it would write; changes nothing
#   sudo ./cloudflare-firewall.sh --remove   take the rules out again
#
# UFW's own rules cannot restrict Docker's published ports: Docker's
# iptables rules see those packets first. Docker passes them through its
# DOCKER-USER chain, which this fills. The rules go into
# /etc/ufw/after.rules and after6.rules between marker lines, so they come
# back after a reboot; running it again replaces them. They match ports 80
# and 443 only: SSH and every other port stay as they are.
#
# It reads the ranges from compose.yaml beside it (the caddy-proxy-cloudflare
# config), or else from https://www.cloudflare.com/ips-v4 and ips-v6.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
compose="$here/compose.yaml"
ufw_dir=${UFW_DIR:-/etc/ufw}
chain=ottertrail-cloudflare
begin="# BEGIN ottertrail-cloudflare (written by cloudflare-firewall.sh; edits here are replaced)"
end="# END ottertrail-cloudflare"

usage() {
  echo "Usage: $0 [--check | --remove]" >&2
  exit 1
}

mode=install
case "${1:-}" in
  "") ;;
  --check) mode=check ;;
  --remove) mode=remove ;;
  *) usage ;;
esac
[ $# -le 1 ] || usage

v4_pattern='^([0-9]{1,3}\.){3}[0-9]{1,3}/([89]|[12][0-9]|3[0-2])$'
v6_pattern='^[0-9a-f:]+:[0-9a-f:]*/(1[6-9]|[2-9][0-9]|1[01][0-9]|12[0-8])$'

# Every range from trusted_proxies in compose.yaml, one per line.
ranges_from_compose() {
  awk '$1 == "trusted_proxies" && $2 == "static" { for (i = 3; i <= NF; i++) print $i }' "$1"
}

ranges_from_cloudflare() {
  local url
  for url in https://www.cloudflare.com/ips-v4 https://www.cloudflare.com/ips-v6; do
    if command -v curl > /dev/null; then
      curl -fsS --max-time 30 "$url"
    else
      wget -q -T 30 -O - "$url"
    fi
    echo
  done
}

# Splits the ranges on stdin into v4 and v6, refusing anything that is not
# a CIDR range, and a result too small to be Cloudflare's.
v4=()
v6=()
sort_ranges() {
  local range
  while IFS= read -r range; do
    range=$(printf '%s' "$range" | tr -d '\r' | tr 'A-F' 'a-f')
    [ -n "$range" ] || continue
    if [[ $range =~ $v4_pattern ]]; then
      v4+=("$range")
    elif [[ $range =~ $v6_pattern ]]; then
      v6+=("$range")
    else
      echo "Not a CIDR range: $range. Nothing was changed." >&2
      exit 1
    fi
  done
  if [ "${#v4[@]}" -lt 5 ] || [ "${#v6[@]}" -lt 3 ]; then
    echo "Only ${#v4[@]} IPv4 and ${#v6[@]} IPv6 ranges: too few to be Cloudflare's. Nothing was changed." >&2
    exit 1
  fi
}

# The rules for one family: $1 is ufw-before-input or ufw6-before-input,
# the rest are the ranges.
rules() {
  local before_input=$1 range port proto
  shift
  echo "$begin"
  echo "*filter"
  # Declaring a chain empties it on each load, so a reload never doubles a rule.
  echo ":DOCKER-USER - [0:0]"
  echo ":$chain - [0:0]"
  # Traffic from the containers themselves (outgoing, or to the server's own
  # address) passes; so does the server's own.
  echo "-A $chain -i lo -j RETURN"
  echo "-A $chain -i docker0 -j RETURN"
  echo "-A $chain -i br-+ -j RETURN"
  for range in "$@"; do
    echo "-A $chain -s $range -j RETURN"
  done
  echo "-A $chain -j DROP"
  # Published ports: DOCKER-USER sees packets after Docker's DNAT, so match
  # the port the client connected to, not the container's.
  for port in tcp:80 tcp:443 udp:443; do
    proto=${port%%:*}
    echo "-A DOCKER-USER -p $proto -m conntrack --ctstate DNAT --ctdir ORIGINAL --ctorigdstport ${port#*:} -j $chain"
  done
  # Connections Docker's userland proxy takes on the server itself, as for
  # IPv6 on a network without IPv6. UFW accepts established ones before this.
  for port in tcp:80 tcp:443 udp:443; do
    proto=${port%%:*}
    echo "-A $before_input -p $proto --dport ${port#*:} -j $chain"
  done
  echo "COMMIT"
  echo "$end"
}

# $1 without the marker block.
without_block() {
  awk -v begin="$begin" -v end="$end" '
    $0 == begin { skip = 1; next }
    skip && $0 == end { skip = 0; next }
    !skip { print }
  ' "$1"
}

# Rules in DOCKER-USER that are not this script's: a reload would empty it.
foreign_rules() {
  "$1" -S DOCKER-USER 2> /dev/null |
    grep -v -e '^-N DOCKER-USER$' -e '^-A DOCKER-USER -j RETURN$' -e "-j $chain\$" || true
}

# Deletes this script's rules from the running firewall, after the reload
# has emptied UFW's chains: UFW leaves DOCKER-USER and this chain alone.
remove_running() {
  local tool=$1 rule parts
  { "$tool" -S DOCKER-USER 2> /dev/null || true; } | { grep -e "-j $chain\$" || true; } |
    while IFS= read -r rule; do
      read -ra parts <<< "${rule/#-A /-D }"
      "$tool" "${parts[@]}" || true
    done
  "$tool" -F "$chain" 2> /dev/null || true
  "$tool" -X "$chain" 2> /dev/null || true
}

# Writes $2 (the block, or nothing) into $1 in place of the old block.
write_rules() {
  local file=$1 block=$2 tmp
  [ -f "$file" ] || { echo "$file is missing: is UFW installed?" >&2; exit 1; }
  [ -f "$file.before-ottertrail" ] || cp -p "$file" "$file.before-ottertrail"
  tmp=$(mktemp "$file.XXXXXX")
  {
    without_block "$file"
    [ -z "$block" ] || printf '%s\n' "$block"
  } > "$tmp"
  chmod --reference="$file" "$tmp"
  mv "$tmp" "$file"
}

if [ "$mode" != remove ]; then
  if [ -f "$compose" ] && [ -n "$(ranges_from_compose "$compose")" ]; then
    from="$compose"
    sort_ranges < <(ranges_from_compose "$compose")
  else
    from="https://www.cloudflare.com/ips-v4 and ips-v6"
    sort_ranges < <(ranges_from_cloudflare)
  fi
  rules4=$(rules ufw-before-input "${v4[@]}")
  rules6=$(rules ufw6-before-input "${v6[@]}")
fi

if [ "$mode" = check ]; then
  echo "Ranges from $from: ${#v4[@]} IPv4, ${#v6[@]} IPv6."
  echo "Only these reach ports 80 and 443 (TCP) and 443 (UDP). Other ports, SSH included, are not matched."
  echo
  echo "== Block for $ufw_dir/after.rules"
  printf '%s\n' "$rules4"
  echo
  echo "== Block for $ufw_dir/after6.rules"
  printf '%s\n' "$rules6"
  exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "Run it with sudo (or --check to see what it would write)." >&2
  exit 1
fi
for tool in ufw iptables ip6tables iptables-restore ip6tables-restore; do
  command -v "$tool" > /dev/null || { echo "$tool is missing. Nothing was changed." >&2; exit 1; }
done
if ! ufw status | grep -q '^Status: active'; then
  echo "UFW is not active, so it would not load the rules. Nothing was changed." >&2
  exit 1
fi

if [ "$mode" = remove ]; then
  write_rules "$ufw_dir/after.rules" ""
  write_rules "$ufw_dir/after6.rules" ""
  ufw reload
  remove_running iptables
  remove_running ip6tables
  echo "Removed: ports 80 and 443 are open to every address again, as UFW allows."
  exit 0
fi

for tool in iptables ip6tables; do
  foreign=$(foreign_rules "$tool")
  if [ -n "$foreign" ]; then
    echo "$tool's DOCKER-USER chain has rules this script did not write, and a reload would empty it:" >&2
    printf '%s\n' "$foreign" >&2
    echo "Nothing was changed. Merge them into the block by hand, or remove them first." >&2
    exit 1
  fi
done

# Check both blocks against the running firewall before writing anything.
printf '%s\n' "$rules4" | iptables-restore --test --noflush
printf '%s\n' "$rules6" | ip6tables-restore --test --noflush

write_rules "$ufw_dir/after.rules" "$rules4"
write_rules "$ufw_dir/after6.rules" "$rules6"
ufw reload
echo "Ports 80 and 443 now take only Cloudflare's ${#v4[@]} IPv4 and ${#v6[@]} IPv6 ranges (from $from)."
echo "Check with: sudo iptables -S DOCKER-USER; sudo iptables -S $chain (and ip6tables)."
