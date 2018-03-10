# vscode-tslinter

## Author:
Yun Wu (yunwu)
Wang Chen (wangchen1117)

This is a vscode extension that provide some shortcuts to run and fix tslint. There is an official one published by Microsoft, but we just create one for fun and learning.

This extension currently supports two functionalities: Run TSLint and Fix TSLint for an opened document.
If the tslint module is not installed or the tslint.json doesn't exist, "Run TSLint" command will fail giving the error message. It would be better if we could automatically install tslint module and add the config file, but don't have enough time to do that.

Refer this doc https://palantir.github.io/tslint/rules/ and see what rules can be automatically fixed.

# How to run the extension
1. Install npm module at the root, client, server folder separately
2. At root folder, run ```npm run compile:server```
3. Start debugging by pressing F5

# Limitation
This plugin only works in Windows environment