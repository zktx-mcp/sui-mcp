"""Run the product swap fixture on a new one-validator, loopback-only chain."""
import argparse
from contextlib import ExitStack
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import time


def unused_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def stop(child):
    child.terminate()
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sui_node", type=Path, help="Path to the Sui node executable")
    parser.add_argument("bundle", type=Path, help="Output of runDeepbookMove.py --bundle")
    parser.add_argument("--refund-inventory", type=Path, metavar="INSTALLED_PACKAGE",
                        help="Check returned coins through the specified installed package's Account card")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="sui-mcp-localnet-") as tmp, ExitStack() as owner:
        root = Path(tmp)
        config = root / "params.yaml"
        config.write_text(f"""ssfn_config_info: ~
validator_config_info: ~
parameters:
  chain_start_timestamp_ms: {time.time_ns() // 1000000}
  protocol_version: 122
  allow_insertion_of_extra_objects: true
  epoch_duration_ms: 86400000
  stake_subsidy_start_epoch: 0
  stake_subsidy_initial_distribution_amount: 1000000000000000
  stake_subsidy_period_length: 10
  stake_subsidy_decrease_rate: 1000
accounts:
""" + ("  - gas_amounts:\n" + "      - 30000000000000000\n" * 5) * 5)
        chain = root / "chain"
        chain.mkdir()
        subprocess.run(["sui", "genesis", "--working-dir", str(chain), "--committee-size", "1", "--from-config", str(config)], check=True, stdout=subprocess.DEVNULL)
        validator, = chain.glob("127.0.0.1-*.yaml")
        port = unused_port()
        for node in (validator, chain / "fullnode.yaml"):
            rpc = port if node.name == "fullnode.yaml" else unused_port()
            cfg = re.sub(r'^json-rpc-address:.*$', f'json-rpc-address: "127.0.0.1:{rpc}"', node.read_text(), flags=re.M)
            node.write_text(cfg.replace("0.0.0.0", "127.0.0.1"))
            log = owner.enter_context((root / (node.name + ".log")).open("w"))
            child = subprocess.Popen([str(args.sui_node.resolve()), "--config-path", str(node)], cwd=root, stdout=log, stderr=log)
            owner.callback(stop, child)
        (chain / "client.yaml").write_text(f'envs:\n  - alias: localnet\n    rpc: "http://127.0.0.1:{port}"\nactive_env: localnet\n')
        for _ in range(120):
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                    break
            except OSError:
                time.sleep(0.25)
        else:
            raise RuntimeError("Disposable fullnode did not start")
        script = "deepbookRefundInventory.mjs" if args.refund_inventory else "deepbookPriceChange.mjs"
        command = ["node", "--import", "tsx", str(Path(__file__).with_name(script)), str(chain), str(args.bundle.resolve())]
        if args.refund_inventory:
            command.append(str(args.refund_inventory.resolve()))
        subprocess.run(command, check=True, timeout=180)


if __name__ == "__main__":
    main()
