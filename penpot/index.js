const fs = require("fs");
const path = require("path");
const axios = require("axios");
const inquirer = require("inquirer");
const semver = require("semver");
const chalk = require("chalk");
const figlet = require("figlet");
const gradient = require("gradient-string");
const ora = require("ora");
const { spawn } = require("child_process");
const config = require("./config");

// Helper to run shell commands
const runCommand = (command, args, options = {}) => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: __dirname,
      stdio: "inherit",
      shell: false,
      ...options,
    });

    child.on("close", (code) => {
      resolve(code); // Resolve with code instead of erroring immediately to allow custom handling
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
};

const runCommandCapture = (command) => {
  return new Promise((resolve, reject) => {
    const { exec } = require("child_process");
    exec(command, { cwd: __dirname }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
};

async function checkDockerRunning() {
  try {
    const stdout = await runCommandCapture("docker --version");
    return !!stdout;
  } catch (e) {
    return false;
  }
}

async function getLatestRelease() {
  const url = `https://api.github.com/repos/${config.githubRepo}/releases/latest`;
  const response = await axios.get(url);
  if (!response.data) throw new Error("No data received from GitHub");
  return response.data;
}

function getLocalVersion() {
  // 1. Check version.txt (managed by this tool)
  if (fs.existsSync(config.versionFile)) {
    return fs.readFileSync(config.versionFile, "utf8").trim();
  }

  // 2. Check .env for PENPOT_VERSION
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf8");
    const match = envContent.match(/PENPOT_VERSION=(.*)/);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  // 3. Check docker-compose.yaml
  if (fs.existsSync(config.localComposeFile)) {
    try {
      const content = fs.readFileSync(config.localComposeFile, "utf8");
      // Look for image: penpotapp/penpot-backend:X.Y.Z or ${VAR:-default}
      const match = content.match(
        /image:\s*"?penpotapp\/.*?backend:(.*?)["'\s]/,
      );
      if (match && match[1]) {
        let val = match[1];
        // Handle ${PENPOT_VERSION:-latest}
        if (val.includes("${PENPOT_VERSION:-")) {
          // Extract default
          const defaultMatch = val.match(/\{PENPOT_VERSION:-(.*?)\}/);
          if (defaultMatch) return defaultMatch[1];
        }
        if (val.includes("$PENPOT_VERSION")) return "Driven by .env (Unknown)";
        return val;
      }
    } catch (e) {
      // ignore
    }
  }

  return "Unknown";
}

function saveLocalVersion(version) {
  fs.writeFileSync(config.versionFile, version);
}

async function updateDockerCompose() {
  const response = await axios.get(config.composeUrl);
  if (fs.existsSync(config.localComposeFile)) {
    fs.copyFileSync(config.localComposeFile, config.backupComposeFile);
  }
  fs.writeFileSync(config.localComposeFile, response.data);
}

function showBanner() {
  console.clear();
  const title = figlet.textSync("Penpot Updater", { font: "Standard" });
  console.log(gradient.pastel.multiline(title));
  console.log(chalk.gray("--------------------------------------------------"));
}

async function main() {
  showBanner();

  const spinner = ora("Checking system status...").start();

  // 0. Ensure Docker is available
  if (!(await checkDockerRunning())) {
    spinner.fail(chalk.red("Docker is not running!"));
    console.log(chalk.yellow("Please start Docker Desktop and try again."));
    process.exit(1);
  }
  spinner.succeed("Docker is running.");

  try {
    spinner.text = "Checking for Penpot updates...";
    spinner.start();

    // Slight delay to prevent flickering
    await new Promise((r) => setTimeout(r, 800));

    const latestRelease = await getLatestRelease();
    const latestVersion = latestRelease.tag_name;
    const localVersion = getLocalVersion();

    spinner.stop();

    console.log(chalk.gray(`\nLocal version:  ${chalk.white(localVersion)}`));
    console.log(chalk.gray(`Latest version: ${chalk.green(latestVersion)}`));

    const cleanLatest = semver.clean(latestVersion) || latestVersion;
    const cleanLocal = semver.clean(localVersion) || localVersion;

    let updateAvailable = false;

    if (cleanLocal === "latest") {
      updateAvailable = true;
    } else if (cleanLocal === "Unknown") {
      updateAvailable = true;
    } else {
      try {
        updateAvailable = semver.gt(cleanLatest, cleanLocal);
      } catch (e) {
        updateAvailable = latestVersion !== localVersion;
      }
    }

    if (updateAvailable) {
      console.log(chalk.bold.green(`\nUpdate Available!`));
      if (localVersion === "latest") {
        console.log(
          chalk.cyan(
            '(You are using "latest" tag. Updating ensures you have the newest build.)',
          ),
        );
      }
      console.log(chalk.white("-----------------------------------"));
      console.log(chalk.white(latestRelease.body.substring(0, 500) + "..."));
      console.log(chalk.white("-----------------------------------\n"));

      const answers = await inquirer.prompt([
        {
          type: "confirm",
          name: "update",
          message: "Do you want to update Penpot now?",
          default: true,
        },
      ]);

      if (answers.update) {
        console.log("");

        // 1. Update docker-compose.yaml
        const composeSpinner = ora(
          "Backing up and updating docker-compose.yaml...",
        ).start();
        await updateDockerCompose();
        composeSpinner.succeed("docker-compose.yaml updated.");

        // 2. Pull images
        console.log(chalk.blue("\nPulling Docker images..."));
        const pullCode = await runCommand("docker", ["compose", "pull"]);
        if (pullCode !== 0) throw new Error("Docker pull failed");
        console.log(chalk.green("✔ Images pulled successfully.\n"));

        // 3. Restart services
        const startSpinner = ora("Restarting Penpot services...").start();
        const upCode = await runCommand("docker", [
          "compose",
          "up",
          "-d",
          "--remove-orphans",
        ]);
        if (upCode !== 0) {
          startSpinner.fail("Failed to start services.");
          throw new Error("Docker up failed");
        }
        startSpinner.succeed("Services restarted.");

        // 4. Update local version
        saveLocalVersion(latestVersion);
        console.log(
          chalk.gray(
            `✔ Created/updated version.txt with version ${latestVersion}`,
          ),
        );

        console.log(chalk.bold.green("\n✔ Update completed successfully!"));
        console.log(chalk.cyan("Penpot should be up and running shortly."));
      } else {
        console.log(chalk.yellow("\nUpdate skipped."));
        await runCommand("docker", ["compose", "up", "-d"]);
        console.log(chalk.green("✔ Services started."));
      }
    } else {
      console.log(chalk.green("\nYou are on the latest version."));
      console.log(chalk.gray("Ensuring services are running..."));
      await runCommand("docker", ["compose", "up", "-d"]);
      console.log(chalk.green("✔ Services started."));
    }
  } catch (error) {
    if (spinner.isSpinning) spinner.stop();

    console.error(chalk.red("\n❌ Error details:"));
    if (error.response) {
      console.error(
        chalk.yellow(
          `GitHub API Error: ${error.response.status} ${error.response.statusText}`,
        ),
      );
    } else {
      console.error(chalk.red(error.stack || error));
    }

    console.log(chalk.yellow("\nAttempting to start local version anyway..."));
    try {
      await runCommand("docker", ["compose", "up", "-d"]);
    } catch (e) {
      // ignore
    }
  }
}

main();
