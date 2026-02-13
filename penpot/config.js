const path = require("path");

module.exports = {
  githubRepo: "penpot/penpot",
  composeUrl:
    "https://raw.githubusercontent.com/penpot/penpot/main/docker/images/docker-compose.yaml",
  localComposeFile: path.join(__dirname, "docker-compose.yaml"),
  backupComposeFile: path.join(__dirname, "docker-compose.backup.yaml"),
  versionFile: path.join(__dirname, "version.txt"), // Store local version here
};
