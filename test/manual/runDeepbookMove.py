"""Run with Python 3.12+, Sui CLI, and local checkouts of the two pinned sources."""
import argparse
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

DEEPBOOK_REV = "8a46552dfac02f2225965dda243bdea1ddcbec89"
SUI_REV = "1ff1fdcd630b6b9bc3d0e21fddfc70d2770c32c3"


def extract(repo, revision, paths, dest):
    archive = subprocess.check_output(["git", "-C", repo, "archive", revision, *paths])
    with tarfile.open(fileobj=io.BytesIO(archive)) as entries:
        entries.extractall(dest, filter="data")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("deepbook", help="MystenLabs/deepbookv3 checkout containing v9.0.0")
    parser.add_argument("sui", help="MystenLabs/sui checkout containing the pinned framework")
    parser.add_argument("--bundle", type=Path, help="Also write the compiled local-genesis bundle for deepbookPriceChange.mjs")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="sui-mcp-move-") as workspace:
        work = Path(workspace)
        extract(args.deepbook, DEEPBOOK_REV, ["packages/deepbook", "packages/token"], work)
        extract(args.sui, SUI_REV, ["crates/sui-framework/packages"], work)
        for name in ("deepbook", "token"):
            manifest = work / "packages" / name / "Move.toml"
            contents = manifest.read_text().replace("[dependencies]", "[dependencies]\nSui = { local = \"../../crates/sui-framework/packages/sui-framework\" }")
            manifest.write_text(contents)
            (manifest.parent / "Move.lock").unlink(missing_ok=True)
            (manifest.parent / "Published.toml").unlink(missing_ok=True)
        package = work / "packages/deepbook"
        for src in Path(__file__).parent.glob("deepbook*.move"):
            shutil.copyfile(src, package / "tests" / src.name)
        config = work / "client.yaml"
        (work / "keystore").write_text("[]")
        config.write_text(f'keystore:\n  File: "{work}/keystore"\nenvs:\n  - alias: localnet\n    rpc: "http://127.0.0.1:9000"\nactive_env: localnet\n')
        cmd = ["sui", "move", "--client.config", str(config), "--path", str(package)]
        env = dict(os.environ, MOVE_HOME=str(work / "move-cache"))
        subprocess.run([*cmd, "test", "--build-env", "testnet", "review_fee"], env=env, check=True)
        if args.bundle:
            data = subprocess.check_output([*cmd, "build", "--build-env", "testnet", "--no-tree-shaking",
                                            "--with-unpublished-dependencies", "--dump-bytecode-as-base64"], env=env)
            bundle = json.loads(data)
            if {int(dep, 16) for dep in bundle["dependencies"]} != {1, 2}:
                raise ValueError("The disposable bundle must include its own DEEP token")
            args.bundle.write_bytes(data)


if __name__ == "__main__":
    main()
