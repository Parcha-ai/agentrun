# Delete the run's files (the bid_ files under any name and the eleven others) and put back what setup moved aside.
# Nothing is deleted unless setup finished moving the phone's own files aside.
D=/sdcard/Download
S=/sdcard/.computer-bench-{{nonce}}
OTHERS="ai_research_paper.pdf machine_learning_notes.txt data_analysis_report.doc chatbot_training_data.txt computer_vision_project.pdf nlp_processing_guide.doc ai_ethics_discussion.txt deep_learning_tutorial.pdf ai_deployment_strategy.doc recommendation_system.txt ai_performance_metrics.pdf"
if [ -e $S/stashed ]; then
	rm -f $D/bid_*
	for f in $OTHERS; do rm -f "$D/$f"; done
fi
for f in $S/stash/*; do if [ -e "$f" ]; then mv "$f" $D/; fi; done
rm -rf $S
true
