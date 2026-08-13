/*
 * LemonLime headless bridge for oi-lan-lemon.
 * This file links against Project LemonLime and is therefore GPL-3.0-or-later.
 */
#include "base/compiler.h"
#include "base/settings.h"
#include "base/LemonLog.hpp"
#include "core/contest.h"
#include "core/contestant.h"
#include "core/task.h"
#include "spdlog/sinks/stdout_color_sinks.h"

#include <QCommandLineParser>
#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QStandardPaths>
#include <cstdio>

static QString resultName(ResultState state) {
    static const QStringList names = {
        "AC", "WA", "PC", "TLE", "MLE", "CANNOT_START", "FILE_ERROR", "RE",
        "INVALID_SPJ", "SPJ_TLE", "SPJ_RE", "SKIPPED", "INTERACTOR_ERROR", "PE", "OLE"
    };
    return state >= 0 && state < names.size() ? names[state] : "UNKNOWN";
}

static QString compileName(CompileState state) {
    static const QStringList names = { "OK", "NO_SOURCE", "CE", "CTLE", "INVALID_COMPILER", "NO_GRADER" };
    return state >= 0 && state < names.size() ? names[state] : "UNKNOWN";
}

static Settings *createSettings(const QString &compilerPath, const QJsonObject &contestSource) {
    auto *settings = new Settings();
    settings->setDefaultFullScore(100);
    settings->setDefaultTimeLimit(1000);
    settings->setDefaultMemoryLimit(512);
    settings->setDefaultExtraTimeRatio(0.2);
    settings->setCompileTimeLimit(20000);
    settings->setSpecialJudgeTimeLimit(10000);
    settings->setFileSizeLimit(50);
    settings->setRejudgeTimes(1);
    settings->setMaxJudgingThreads(1);
    settings->setDefaultInputFileExtension("in");
    settings->setDefaultOutputFileExtension("out");
    settings->setInputFileExtensions("in");
    settings->setOutputFileExtensions("out;ans");

    auto *compiler = new Compiler();
    compiler->setCompilerType(Compiler::Typical);
    compiler->setCompilerName("g++");
    compiler->setSourceExtensions("cpp;cc;cxx");
    compiler->setCompilerLocation(compilerPath);
    compiler->setTimeLimitRatio(1.0);
    compiler->setMemoryLimitRatio(1.0);
    compiler->setDisableMemoryLimitCheck(false);
    compiler->setInterpreterAsWatcher(false);
    const QString compilerArguments = "%s.* -o %s -std=c++14 -O2 -lm";
    QStringList configurationNames = { "default" };
    for (const QJsonValue &taskValue : contestSource.value("tasks").toArray()) {
        const QString name = taskValue.toObject().value("compilerConfiguration").toObject().value("g++").toString();
        if (!name.isEmpty() && name != "disable" && !configurationNames.contains(name))
            configurationNames.append(name);
    }
    for (const QString &name : configurationNames)
        compiler->addConfiguration(name, compilerArguments, "");
    settings->addCompiler(compiler);
    return settings;
}

int main(int argc, char *argv[]) {
    QCoreApplication app(argc, argv);
    QCoreApplication::setApplicationName("lemon-headless");

    QCommandLineParser parser;
    parser.addHelpOption();
    parser.addOption({ "contest", "Path to the LemonLime CDF file", "cdf" });
    parser.addOption({ "compiler", "Path/name of g++", "g++", "g++" });
    parser.process(app);

    const QString cdfPath = QFileInfo(parser.value("contest")).absoluteFilePath();
    if (cdfPath.isEmpty() || !QFileInfo::exists(cdfPath)) {
        qCritical("CDF does not exist");
        return 2;
    }
    QString compilerPath = parser.value("compiler");
    if (!QFileInfo::exists(compilerPath)) compilerPath = QStandardPaths::findExecutable(compilerPath);
    if (compilerPath.isEmpty()) {
        qCritical("g++ was not found");
        return 3;
    }

    auto sink = std::make_shared<spdlog::sinks::stderr_color_sink_mt>();
    sink->set_level(spdlog::level::warn);
    Lemon::base::logger = std::make_shared<spdlog::logger>("lemon-headless", sink);

    QFile file(cdfPath);
    if (!file.open(QFile::ReadOnly)) return 4;
    QJsonParseError parseError;
    const QJsonObject source = QJsonDocument::fromJson(file.readAll(), &parseError).object();
    if (parseError.error != QJsonParseError::NoError) return 5;

    QDir::setCurrent(QFileInfo(cdfPath).absolutePath());
    std::unique_ptr<Settings> settings(createSettings(compilerPath, source));
    Contest contest;
    contest.setSettings(settings.get());
    if (contest.readFromJson(source) == -1) return 6;
    contest.refreshContestantList();
    contest.judgeAll();

    QJsonArray contestantsJson;
    const auto tasks = contest.getTaskList();
    for (Contestant *contestant : contest.getContestantList()) {
        QJsonObject contestantJson;
        contestantJson["studentId"] = contestant->getContestantName();
        contestantJson["totalScore"] = contestant->getTotalScore();
        contestantJson["totalTime"] = contestant->getTotalUsedTime();
        QJsonArray tasksJson;
        for (int i = 0; i < tasks.size(); ++i) {
            QJsonObject taskJson;
            taskJson["title"] = tasks[i]->getProblemTitle();
            taskJson["score"] = contestant->getTaskScore(i);
            taskJson["compile"] = compileName(contestant->getCompileState(i));
            taskJson["compileMessage"] = contestant->getCompileMessage(i);
            QJsonArray casesJson;
            const auto results = contestant->getResult(i);
            const auto scores = contestant->getScore(i);
            const auto times = contestant->getTimeUsed(i);
            const auto memory = contestant->getMemoryUsed(i);
            for (int group = 0; group < results.size(); ++group) {
                for (int test = 0; test < results[group].size(); ++test) {
                    QJsonObject caseJson;
                    caseJson["group"] = group + 1;
                    caseJson["case"] = test + 1;
                    caseJson["result"] = resultName(results[group][test]);
                    caseJson["score"] = scores.value(group).value(test);
                    caseJson["time"] = times.value(group).value(test);
                    caseJson["memory"] = static_cast<qint64>(memory.value(group).value(test));
                    casesJson.append(caseJson);
                }
            }
            taskJson["cases"] = casesJson;
            tasksJson.append(taskJson);
        }
        contestantJson["tasks"] = tasksJson;
        contestantsJson.append(contestantJson);
    }
    QJsonObject output;
    output["contestTitle"] = contest.getContestTitle();
    output["contestants"] = contestantsJson;
    const QByteArray result = QJsonDocument(output).toJson(QJsonDocument::Compact) + '\n';
    std::fwrite(result.constData(), 1, static_cast<size_t>(result.size()), stdout);
    std::fflush(stdout);
    return 0;
}
