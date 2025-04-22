# app.py

from flask import Flask, jsonify, send_from_directory, abort
import os

app = Flask(__name__)

# 本地存放 .vsix 文件的目录（相对或绝对路径）
VSIX_DIR = os.path.join(os.path.dirname(__file__), "vsix_files")

@app.route("/extensions", methods=["GET"])
def list_extensions():
    """
    列出 VSIX_DIR 下所有 .vsix 文件，返回 JSON 数组：
    [
      {"name": "my-plugin-1.0.0.vsix", "url": "/extensions/my-plugin-1.0.0.vsix"},
      ...
    ]
    """
    try:
        files = [
            fname for fname in os.listdir(VSIX_DIR)
            if fname.lower().endswith(".vsix")
        ]
    except FileNotFoundError:
        # 目录不存在
        return jsonify({"error": "VSIX directory not found"}), 500

    extensions = [
        {"name": fname, "url": f"/{fname}"}
        for fname in files
    ]
    return jsonify(extensions)


@app.route("/extensions/<string:name>", methods=["GET"])
def download_extension(name):
    """
    根据插件文件名返回 .vsix 二进制，Content-Type 自动设为 application/octet-stream
    """
    # 安全检查：只允许 .vsix，防止路径穿越
    if not name.lower().endswith(".vsix"):
        abort(404)

    try:
        return send_from_directory(
            directory=VSIX_DIR,
            path=name,
            as_attachment=True,
            mimetype="application/octet-stream"
        )
    except FileNotFoundError:
        abort(404)


if __name__ == "__main__":
    # 在开发环境下启动
    app.run(host="0.0.0.0", port=8000, debug=True)