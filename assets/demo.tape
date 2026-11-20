# VHS tape recipe for recording assets/demo.gif
# Requires https://github.com/charmbracelet/vhs

Output assets/demo.gif
Set Shell "bash"
Set FontSize 14
Set Width 1100
Set Height 680
Set Padding 20
Set TypingSpeed 40ms

Type "node src/cli.mjs doctor | head -n 30"
Enter
Sleep 2.5s

Type "node src/cli.mjs stats --table"
Enter
Sleep 2.5s

Type "node src/cli.mjs cross-review --style standard --scope uncommitted --structured"
Enter
Sleep 6s

Type "node src/cli.mjs watch --once"
Enter
Sleep 3s
