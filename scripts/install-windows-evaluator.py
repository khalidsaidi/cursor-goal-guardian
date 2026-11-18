"""Install evaluator wheels with launchers for the packaged Windows interpreter."""

import sys
from pathlib import Path
from zipfile import ZipFile


def main():
    runtime, target, *pip_args = sys.argv[1:]
    # Both the installer and its native launcher templates come from the
    # checksum-verified target Python distribution, including on Linux builders.
    (wheel,) = (Path(runtime) / "Lib/ensurepip/_bundled").glob("pip-*.whl")
    sys.path.insert(0, str(wheel))
    from pip._internal.cli.main import main as install
    from pip._internal.operations.install import wheel as wheel_install

    arch = {"win32-x64": "64", "win32-arm64": "64-arm"}[target]

    class BundledScriptMaker(wheel_install.PipScriptMaker):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._is_nt = True
            self.executable = r"<launcher_dir>\..\..\..\bin\python\python.exe"

        def _get_launcher(self, kind):
            with ZipFile(wheel) as archive:
                return archive.read(f"pip/_vendor/distlib/{kind}{arch}.exe")

        def _get_script_text(self, entry):
            # pip --target puts the modules one directory above their launchers.
            return (
                "import sys\nfrom pathlib import Path\n"
                "sys.path.insert(0, str(Path(sys.argv[0]).resolve().parent.parent))\n"
                + super()._get_script_text(entry)
            )

    wheel_install.PipScriptMaker = BundledScriptMaker
    return install(pip_args)


if __name__ == "__main__":
    sys.exit(main())
