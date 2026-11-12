// Run with an explicitly supplied ImageJ jar. No source image intensity is measured.
import ij.ImagePlus;
import ij.gui.Roi;
import ij.io.RoiDecoder;
import ij.measure.Calibration;
import ij.measure.Measurements;
import ij.process.ByteProcessor;
import java.nio.file.*;
import java.util.*;
class ImageJMeasurements {
 static String csv(String value) { return "\"" + value.replace("\"", "\"\"") + "\""; }
 public static void main(String[] args) throws Exception {
  int width=Integer.parseInt(args[1]),height=Integer.parseInt(args[2]);
  double sx=Double.parseDouble(args[3]),sy=Double.parseDouble(args[4]);
  if(width<1||height<1||(long)width*height>40000000||!Double.isFinite(sx)||!Double.isFinite(sy)||sx<=0||sy<=0)throw new IllegalArgumentException("Invalid image grid or calibration");
  ImagePlus image=new ImagePlus("BLANK_GEOMETRY_GRID_NOT_ORIGINAL_TIFF",new ByteProcessor(width,height));
  Calibration calibration=new Calibration();calibration.pixelWidth=sx;calibration.pixelHeight=sy;calibration.setUnit("um");image.setCalibration(calibration);
  System.out.println("ROI_Name,type,area_um2,perimeter_or_line_length_um,stroke_width_px,is_area");
  try(var files=Files.list(Path.of(args[0]))) {
   for(Path p:files.sorted().toList()) {
    Roi roi=new RoiDecoder(p.toString()).getRoi();image.setRoi(roi);
    String area=roi.isArea()?String.format(Locale.ROOT,"%.12f",image.getStatistics(Measurements.AREA).area):"";
    System.out.printf(Locale.ROOT,"%s,%s,%s,%.12f,%.6f,%s%n",csv(roi.getName()),csv(roi.getTypeAsString()),area,roi.getLength(),roi.getStrokeWidth(),roi.isArea());
   }
  }
  image.close();
 }
}
